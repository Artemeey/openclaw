#import <Foundation/Foundation.h>

@interface OpenClawFaceTimeConnectionAuthenticator : NSObject

- (instancetype)initWithToken:(NSString *)token;
- (NSDictionary *)beginWithBundleIdentifier:(NSString *)bundleIdentifier
                                     buildID:(NSString *)buildID
                                   processID:(NSNumber *)processID
                          processStartedAtMs:(NSNumber *)processStartedAtMs;
- (NSDictionary *)consumeServerHello:(NSDictionary *)message;
- (NSDictionary *)consumeIncomingEnvelope:(NSDictionary *)envelope;
- (NSDictionary *)protectOutgoingPayload:(NSDictionary *)payload;
- (void)reset;

@property(nonatomic, readonly, getter=isReady) BOOL ready;

@end
