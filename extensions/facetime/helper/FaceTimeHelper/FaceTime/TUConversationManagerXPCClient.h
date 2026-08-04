#import <Foundation/Foundation.h>

@interface TUConversationManagerXPCClient : NSObject
- (void)setLocalParticipantAudioVideoMode:(NSUInteger)mode
                      forConversationUUID:(NSUUID *)conversationUUID;
@end
