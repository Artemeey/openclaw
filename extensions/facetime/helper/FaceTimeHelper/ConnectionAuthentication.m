#import "ConnectionAuthentication.h"

#import <CommonCrypto/CommonHMAC.h>
#import <Security/Security.h>

static NSString *OpenClawConnectionHMAC(NSString *key, NSString *message) {
    NSData *keyData = [key dataUsingEncoding:NSUTF8StringEncoding];
    NSData *payload = [message dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CCHmac(kCCHmacAlgSHA256, keyData.bytes, keyData.length, payload.bytes, payload.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
        [hex appendFormat:@"%02x", digest[index]];
    }
    return hex;
}

static BOOL OpenClawConnectionStringsEqual(NSString *first, NSString *second) {
    NSData *firstData = [first dataUsingEncoding:NSUTF8StringEncoding];
    NSData *secondData = [second dataUsingEncoding:NSUTF8StringEncoding];
    if (firstData.length == 0 || firstData.length != secondData.length) {
        return NO;
    }
    const unsigned char *firstBytes = firstData.bytes;
    const unsigned char *secondBytes = secondData.bytes;
    unsigned char difference = 0;
    for (NSUInteger index = 0; index < firstData.length; index++) {
        difference |= firstBytes[index] ^ secondBytes[index];
    }
    return difference == 0;
}

static BOOL OpenClawConnectionHasExactKeys(NSDictionary *dictionary, NSArray<NSString *> *keys) {
    return dictionary.count == keys.count &&
        [[NSSet setWithArray:dictionary.allKeys] isEqualToSet:[NSSet setWithArray:keys]];
}

static NSString *OpenClawConnectionRandomNonce(void) {
    unsigned char bytes[32];
    if (SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) != errSecSuccess) {
        return nil;
    }
    NSMutableString *hex = [NSMutableString stringWithCapacity:sizeof(bytes) * 2];
    for (NSUInteger index = 0; index < sizeof(bytes); index++) {
        [hex appendFormat:@"%02x", bytes[index]];
    }
    return hex;
}

@implementation OpenClawFaceTimeConnectionAuthenticator {
    NSString *_token;
    NSString *_bundleIdentifier;
    NSString *_buildID;
    NSNumber *_processID;
    NSNumber *_processStartedAtMs;
    NSString *_clientNonce;
    NSString *_connectionEpoch;
    NSString *_connectionKey;
    NSUInteger _incomingSequence;
    NSUInteger _outgoingSequence;
    BOOL _ready;
}

- (instancetype)initWithToken:(NSString *)token {
    self = [super init];
    if (self) {
        _token = [token copy];
        [self reset];
    }
    return self;
}

- (BOOL)isReady {
    @synchronized(self) {
        return _ready;
    }
}

- (void)reset {
    @synchronized(self) {
        _bundleIdentifier = nil;
        _buildID = nil;
        _processID = nil;
        _processStartedAtMs = nil;
        _clientNonce = nil;
        _connectionEpoch = nil;
        _connectionKey = nil;
        _incomingSequence = 0;
        _outgoingSequence = 0;
        _ready = NO;
    }
}

- (NSDictionary *)beginWithBundleIdentifier:(NSString *)bundleIdentifier
                                     buildID:(NSString *)buildID
                                   processID:(NSNumber *)processID
                          processStartedAtMs:(NSNumber *)processStartedAtMs {
    @synchronized(self) {
        [self reset];
        NSString *nonce = OpenClawConnectionRandomNonce();
        if (bundleIdentifier.length == 0 || buildID.length == 0 || processID.longLongValue <= 0 ||
            processStartedAtMs.longLongValue <= 0 || nonce.length == 0) {
            return nil;
        }
        _bundleIdentifier = [bundleIdentifier copy];
        _buildID = [buildID copy];
        _processID = processID;
        _processStartedAtMs = processStartedAtMs;
        _clientNonce = nonce;
        NSString *proof = OpenClawConnectionHMAC(
            _token,
            [NSString stringWithFormat:@"client-hello\n%@\n%@\n%@\n%@\n%@",
                _bundleIdentifier, _buildID, _processID, _processStartedAtMs, _clientNonce]
        );
        return @{
            @"event": @"client-hello",
            @"bundle_identifier": _bundleIdentifier,
            @"build_id": _buildID,
            @"process_id": _processID,
            @"process_started_at_ms": _processStartedAtMs,
            @"client_nonce": _clientNonce,
            @"proof": proof,
        };
    }
}

- (NSDictionary *)consumeServerHello:(NSDictionary *)message {
    @synchronized(self) {
        NSArray *keys = @[@"event", @"client_nonce", @"server_nonce", @"connection_epoch", @"proof"];
        if (!OpenClawConnectionHasExactKeys(message, keys) ||
            ![message[@"event"] isEqualToString:@"server-hello"] || _clientNonce.length == 0 ||
            ![message[@"client_nonce"] isEqualToString:_clientNonce]) {
            return nil;
        }
        NSString *serverNonce = [message[@"server_nonce"] isKindOfClass:[NSString class]]
            ? message[@"server_nonce"] : @"";
        NSString *epoch = [message[@"connection_epoch"] isKindOfClass:[NSString class]]
            ? message[@"connection_epoch"] : @"";
        NSString *receivedProof = [message[@"proof"] isKindOfClass:[NSString class]]
            ? message[@"proof"] : @"";
        if (serverNonce.length == 0 || epoch.length == 0) {
            return nil;
        }
        NSString *context = [NSString stringWithFormat:@"%@\n%@\n%@\n%@\n%@\n%@\n%@",
            _bundleIdentifier, _buildID, _processID, _processStartedAtMs, _clientNonce, serverNonce, epoch];
        NSString *expectedProof = OpenClawConnectionHMAC(
            _token,
            [NSString stringWithFormat:@"server-hello\n%@", context]
        );
        if (!OpenClawConnectionStringsEqual(receivedProof, expectedProof)) {
            return nil;
        }
        _connectionEpoch = [epoch copy];
        _connectionKey = OpenClawConnectionHMAC(
            _token,
            [NSString stringWithFormat:@"session\n%@", context]
        );
        NSString *clientProof = OpenClawConnectionHMAC(
            _connectionKey,
            [NSString stringWithFormat:@"client-finish\n%@", _connectionEpoch]
        );
        return @{
            @"event": @"client-finish",
            @"connection_epoch": _connectionEpoch,
            @"proof": clientProof,
        };
    }
}

- (NSDictionary *)consumeIncomingEnvelope:(NSDictionary *)envelope {
    @synchronized(self) {
        NSArray *keys = @[@"connection_epoch", @"sequence", @"direction", @"payload_json", @"auth"];
        if (!OpenClawConnectionHasExactKeys(envelope, keys) || _connectionKey.length == 0 ||
            ![envelope[@"connection_epoch"] isEqualToString:_connectionEpoch] ||
            ![envelope[@"direction"] isEqualToString:@"server-to-helper"] ||
            ![envelope[@"sequence"] isKindOfClass:[NSNumber class]] ||
            ![envelope[@"payload_json"] isKindOfClass:[NSString class]] ||
            ![envelope[@"auth"] isKindOfClass:[NSString class]]) {
            return nil;
        }
        NSUInteger sequence = [envelope[@"sequence"] unsignedIntegerValue];
        if (sequence != _incomingSequence + 1) {
            return nil;
        }
        NSString *payloadJSON = envelope[@"payload_json"];
        NSString *expectedAuth = OpenClawConnectionHMAC(
            _connectionKey,
            [NSString stringWithFormat:@"message\nserver-to-helper\n%@\n%lu\n%@",
                _connectionEpoch, (unsigned long)sequence, payloadJSON]
        );
        if (!OpenClawConnectionStringsEqual(envelope[@"auth"], expectedAuth)) {
            return nil;
        }
        NSError *error;
        id payload = [NSJSONSerialization JSONObjectWithData:[payloadJSON dataUsingEncoding:NSUTF8StringEncoding]
                                                     options:0
                                                       error:&error];
        if (![payload isKindOfClass:[NSDictionary class]]) {
            return nil;
        }
        _incomingSequence = sequence;
        if (!_ready) {
            if (sequence != 1 || !OpenClawConnectionHasExactKeys(payload, @[@"event"]) ||
                ![payload[@"event"] isEqualToString:@"session-ready"]) {
                return nil;
            }
            _ready = YES;
        }
        return payload;
    }
}

- (NSDictionary *)protectOutgoingPayload:(NSDictionary *)payload {
    @synchronized(self) {
        if (!_ready || _connectionKey.length == 0) {
            return nil;
        }
        NSError *error;
        NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
        if (payloadData == nil) {
            return nil;
        }
        NSString *payloadJSON = [[NSString alloc] initWithData:payloadData encoding:NSUTF8StringEncoding];
        NSUInteger sequence = ++_outgoingSequence;
        NSString *auth = OpenClawConnectionHMAC(
            _connectionKey,
            [NSString stringWithFormat:@"message\nhelper-to-server\n%@\n%lu\n%@",
                _connectionEpoch, (unsigned long)sequence, payloadJSON]
        );
        return @{
            @"connection_epoch": _connectionEpoch,
            @"sequence": @(sequence),
            @"direction": @"helper-to-server",
            @"payload_json": payloadJSON,
            @"auth": auth,
        };
    }
}

@end
