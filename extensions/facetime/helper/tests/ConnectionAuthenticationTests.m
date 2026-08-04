#import <CommonCrypto/CommonHMAC.h>
#import <Foundation/Foundation.h>

#import "../FaceTimeHelper/ConnectionAuthentication.h"

static NSString *TestHMAC(NSString *key, NSString *message) {
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

static NSDictionary *Envelope(
    NSString *key,
    NSString *epoch,
    NSUInteger sequence,
    NSString *payloadJSON
) {
    return @{
        @"connection_epoch": epoch,
        @"sequence": @(sequence),
        @"direction": @"server-to-helper",
        @"payload_json": payloadJSON,
        @"auth": TestHMAC(
            key,
            [NSString stringWithFormat:@"message\nserver-to-helper\n%@\n%lu\n%@",
                epoch, (unsigned long)sequence, payloadJSON]
        ),
    };
}

int main(void) {
    @autoreleasepool {
        NSString *token = [@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0];
        NSString *bundleID = @"com.apple.FaceTime";
        NSString *buildID = [@"b" stringByPaddingToLength:64 withString:@"b" startingAtIndex:0];
        NSNumber *processID = @1234;
        NSNumber *processStartedAtMs = @1700000000000;
        OpenClawFaceTimeConnectionAuthenticator *authenticator =
            [[OpenClawFaceTimeConnectionAuthenticator alloc] initWithToken:token];

        NSDictionary *clientHello = [authenticator
            beginWithBundleIdentifier:bundleID
            buildID:buildID
            processID:processID
            processStartedAtMs:processStartedAtMs];
        NSString *clientNonce = clientHello[@"client_nonce"];
        NSCAssert(clientNonce.length == 64, @"helper must generate a fresh 256-bit nonce");

        NSString *serverNonce = [@"c" stringByPaddingToLength:64 withString:@"c" startingAtIndex:0];
        NSString *epoch = @"epoch-1";
        NSString *context = [NSString stringWithFormat:@"%@\n%@\n%@\n%@\n%@\n%@\n%@",
            bundleID, buildID, processID, processStartedAtMs, clientNonce, serverNonce, epoch];
        NSDictionary *invalidServerHello = @{
            @"event": @"server-hello",
            @"client_nonce": clientNonce,
            @"server_nonce": serverNonce,
            @"connection_epoch": epoch,
            @"proof": @"not-a-valid-proof",
        };
        NSCAssert(
            [authenticator consumeServerHello:invalidServerHello] == nil,
            @"helper must reject a server that cannot prove possession of the IPC key"
        );

        NSDictionary *serverHello = @{
            @"event": @"server-hello",
            @"client_nonce": clientNonce,
            @"server_nonce": serverNonce,
            @"connection_epoch": epoch,
            @"proof": TestHMAC(token, [NSString stringWithFormat:@"server-hello\n%@", context]),
        };
        NSDictionary *clientFinish = [authenticator consumeServerHello:serverHello];
        NSString *connectionKey = TestHMAC(token, [NSString stringWithFormat:@"session\n%@", context]);
        NSCAssert(
            [clientFinish[@"proof"] isEqualToString:TestHMAC(connectionKey, @"client-finish\nepoch-1")],
            @"client finish must bind the derived connection key"
        );
        NSCAssert(!authenticator.ready, @"events must stay disabled until the server confirms the session");

        NSDictionary *ready = [authenticator consumeIncomingEnvelope:
            Envelope(connectionKey, epoch, 1, @"{\"event\":\"session-ready\"}")];
        NSCAssert([ready[@"event"] isEqualToString:@"session-ready"] && authenticator.ready,
            @"the first signed server payload must establish readiness");

        NSDictionary *protectedEvent = [authenticator protectOutgoingPayload:@{
            @"event": @"ft-call-status-changed",
            @"data": @{},
        }];
        NSCAssert([protectedEvent[@"direction"] isEqualToString:@"helper-to-server"],
            @"helper events must be direction bound");
        NSCAssert([protectedEvent[@"sequence"] unsignedIntegerValue] == 1,
            @"helper event sequence must start at one");

        NSDictionary *action = Envelope(
            connectionKey,
            epoch,
            2,
            @"{\"action\":\"safety-mute\",\"transactionId\":\"tx-1\",\"data\":{}}"
        );
        NSCAssert([authenticator consumeIncomingEnvelope:action] != nil,
            @"the next authenticated action must be accepted");
        NSCAssert([authenticator consumeIncomingEnvelope:action] == nil,
            @"a captured action envelope must not replay in one connection");

        [authenticator beginWithBundleIdentifier:bundleID
                                         buildID:buildID
                                       processID:processID
                              processStartedAtMs:processStartedAtMs];
        NSCAssert([authenticator consumeIncomingEnvelope:action] == nil,
            @"an envelope from a prior connection epoch must not replay after reconnect");
    }
    return 0;
}
