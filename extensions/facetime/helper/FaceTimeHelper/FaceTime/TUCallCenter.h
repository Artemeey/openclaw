#import <Foundation/Foundation.h>

@class TUCall, TUConversation;

@interface TUCallCenter : NSObject
@property(readonly, copy, nonatomic) NSArray<TUCall *> *currentAudioAndVideoCalls;
@property(readonly, copy, nonatomic) NSArray<TUCall *> *currentCalls;
@property(readonly, copy, nonatomic) NSArray<TUCall *> *displayedAudioAndVideoCalls;
@property(readonly, copy, nonatomic) NSArray<TUCall *> *displayedCalls;
@property(readonly, nonatomic) TUCall *incomingCall;
@property(readonly, copy, nonatomic) NSArray<TUCall *> *incomingCalls;
@property(readonly, nonatomic) TUCall *incomingVideoCall;

+ (instancetype)sharedInstance;
- (TUConversation *)activeConversationForCall:(TUCall *)call;
- (void)answerOrJoinCall:(TUCall *)call;
- (BOOL)canDialWithRequest:(id)request;
- (TUCall *)callWithCallUUID:(NSString *)callUUID;
- (TUCall *)dialWithRequest:(id)request;
- (void)disconnectCall:(TUCall *)call;
- (void)startTransmissionForBargeCall:(TUCall *)call
           sourceIsHandsfreeAccessory:(BOOL)sourceIsHandsfreeAccessory;

@end
