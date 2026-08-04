#import <Foundation/Foundation.h>

@interface TUConversationManager : NSObject
- (void)setLocalParticipantAudioVideoMode:(NSUInteger)mode
                      forConversationUUID:(NSUUID *)conversationUUID;
@end
