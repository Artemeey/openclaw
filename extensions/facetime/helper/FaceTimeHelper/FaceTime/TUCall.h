#import <Foundation/Foundation.h>
#import "TUHandle.h"

@interface TUCall : NSObject
@property(readonly, nonatomic) NSString *audioMode;
@property(readonly, nonatomic) int callStatus;
@property(readonly, nonatomic) NSString *callUUID;
@property(retain, nonatomic) TUCall *comparativeCall;
@property(retain, nonatomic) NSDate *dateEnded;
@property(nonatomic) int disconnectedReason;
@property(readonly, nonatomic) NSString *endedErrorString;
@property(readonly, nonatomic) NSString *endedReasonString;
@property(readonly, nonatomic) NSInteger faceTimeTransportType;
@property(readonly, nonatomic) TUHandle *handle;
@property(readonly, nonatomic, getter=isConversation) BOOL conversation;
@property(nonatomic, getter=isDownlinkMuted) BOOL downlinkMuted;
@property(readonly, nonatomic, getter=isEmergencyCall) BOOL emergencyCall;
@property(nonatomic, getter=isEndpointOnCurrentDevice) BOOL endpointOnCurrentDevice;
@property(nonatomic, getter=isHostedOnCurrentDevice) BOOL hostedOnCurrentDevice;
@property(readonly, nonatomic, getter=isOutgoing) BOOL outgoing;
@property(readonly, nonatomic) NSObject *provider;
@property(readonly, nonatomic) BOOL isSendingAudio;
@property(readonly, nonatomic, getter=isSendingTransmission) BOOL sendingTransmission;
@property(nonatomic) BOOL isSendingVideo;
@property(nonatomic, getter=isUplinkMuted) BOOL uplinkMuted;
@property(readonly, nonatomic, getter=isUsingBaseband) BOOL usingBaseband;
@property(readonly, nonatomic, getter=isVoIPCall) BOOL voipCall;
@property(readonly, nonatomic, getter=isWiFiCall) BOOL wiFiCall;
@property(readonly, nonatomic) float localMeterLevel;
@property(readonly, nonatomic) float remoteMeterLevel;
@property(readonly, nonatomic) int service;
@property(copy, nonatomic) NSString *uniqueProxyIdentifier;

- (BOOL)isMuted;
- (BOOL)setMuted:(BOOL)muted;

@end
