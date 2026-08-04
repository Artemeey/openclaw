#import <Foundation/Foundation.h>

@interface TUConversation : NSObject
@property(readonly, nonatomic) NSUUID *UUID;
@property(readonly, nonatomic) NSUUID *groupUUID;
@property(nonatomic, getter=isAudioEnabled) BOOL audioEnabled;
@property(nonatomic, getter=isVideoEnabled) BOOL videoEnabled;
@property(nonatomic) NSUInteger avMode;
@property(readonly, nonatomic) NSUInteger resolvedAudioVideoMode;
@end
