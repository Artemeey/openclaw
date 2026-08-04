// Adapted and modified by OpenClaw contributors in 2026.
// Upstream BlueBubbles helper is Apache-2.0; see THIRD_PARTY_NOTICES.md.

@import AppKit;

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <libproc.h>

#import "NetworkController.h"
#import "ConnectionAuthentication.h"
#import "Logging.h"
#import "TUConversationManager.h"
#import "TUConversationManagerXPCClient.h"
#import "TUCallCenter.h"
#import "TUConversation.h"
#import "TUCall.h"

// Kept local because TelephonyUtilities is private and its headers are not in
// the macOS SDK. These selectors are checked again at runtime before use.
@interface TUDialRequest : NSObject
- (instancetype)initWithURL:(NSURL *)URL;
@property(nonatomic, getter=isVideo) BOOL video;
@property(nonatomic) BOOL showUIPrompt;
@property(nonatomic, readonly, getter=isValid) BOOL valid;
@property(nonatomic, readonly, copy) NSArray *validityErrors;
@end

@interface CSDConversationManager : NSObject
- (void)setUplinkMuted:(BOOL)muted forConversationWithUUID:(NSUUID *)conversationUUID;
- (void)setUplinkMuted:(BOOL)muted forPendingConversationWithUUID:(NSUUID *)conversationUUID;
- (void)setAudioPaused:(BOOL)paused forConversationWithUUID:(NSUUID *)conversationUUID;
- (void)startAudioForConversationWithUUID:(NSUUID *)conversationUUID;
@end

@interface NSObject (OpenClawCallProviderClassification)
- (BOOL)isFaceTimeProvider;
- (BOOL)isTelephonyProvider;
@end

#ifndef OPENCLAW_FACETIME_HELPER_TOKEN
#error "Build the helper with scripts/build-helper-macabi.sh to configure IPC authentication."
#endif
#ifndef OPENCLAW_FACETIME_HELPER_BUILD_ID
#error "Build the helper with scripts/build-helper-macabi.sh to configure its build identity."
#endif

static NSNumber *ProcessStartedAtMilliseconds(void) {
    struct proc_bsdinfo info = {0};
    int size = proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (size != sizeof(info)) {
        return @0;
    }
    uint64_t milliseconds = ((uint64_t)info.pbi_start_tvsec * 1000) +
        ((uint64_t)info.pbi_start_tvusec / 1000);
    return @(milliseconds);
}

static NSDictionary *CallTransportEvidence(TUCall *call) {
    if (call == nil) {
        return @{
            @"kind": @"unknown",
            @"classifier_version": @"tu-provider-v1",
        };
    }
    NSInteger service = [call service];
    NSInteger faceTimeTransportType = [call faceTimeTransportType];
    id provider = [call provider];
    BOOL providerClassified = [provider respondsToSelector:@selector(isFaceTimeProvider)] &&
        [provider respondsToSelector:@selector(isTelephonyProvider)];
    BOOL faceTimeProvider = providerClassified && [provider isFaceTimeProvider];
    BOOL telephonyProvider = providerClassified && [provider isTelephonyProvider];
    BOOL usingBaseband = [call isUsingBaseband];
    BOOL wifiCall = [call isWiFiCall];
    BOOL voip = [call isVoIPCall];
    BOOL emergency = [call isEmergencyCall];
    // Current TUCallProviderManager maps FaceTime audio/video to services 2/3;
    // service 1 is telephony, including Wi-Fi calling. Provider classification
    // remains mandatory so a numeric service change fails closed.
    BOOL verifiedFaceTime = providerClassified && faceTimeProvider && !telephonyProvider &&
        (service == 2 || service == 3) && !usingBaseband && !wifiCall && voip && !emergency;
    NSString *kind = verifiedFaceTime
        ? @"facetime"
        : (telephonyProvider || service == 1 || usingBaseband || wifiCall || emergency
            ? @"cellular"
            : @"unknown");
    return @{
        @"kind": kind,
        @"classifier_version": @"tu-provider-v1",
        @"service": @(service),
        @"facetime_transport_type": @(faceTimeTransportType),
        @"provider_classified": @(providerClassified),
        @"provider_is_facetime": @(faceTimeProvider),
        @"provider_is_telephony": @(telephonyProvider),
        @"is_using_baseband": @(usingBaseband),
        @"is_wifi_call": @(wifiCall),
        @"is_voip": @(voip),
        @"is_emergency": @(emergency),
    };
}

static BOOL IsVerifiedFaceTimeCall(TUCall *call) {
    return [CallTransportEvidence(call)[@"kind"] isEqualToString:@"facetime"];
}

static BOOL ApplyOutboundSafetyMute(TUCall *call) {
    if (!IsVerifiedFaceTimeCall(call)) {
        return NO;
    }
    [call setMuted:YES];
    [call setUplinkMuted:YES];
    return [call isMuted] && [call isUplinkMuted];
}

static NSMutableDictionary<NSString *, TUCall *> *OutboundCallsByDialID;
static NSMutableSet<NSString *> *CancelledOutboundDialIDs;
static OpenClawFaceTimeConnectionAuthenticator *ConnectionAuthenticator;

static void RestoreOutboundState(void) {
    TUCallCenter *owner = [TUCallCenter sharedInstance];
    SEL callsKey = NSSelectorFromString(@"openclaw_facetimeHelper_outboundCallsByDialID");
    SEL cancelledKey = NSSelectorFromString(@"openclaw_facetimeHelper_cancelledOutboundDialIDs");

    OutboundCallsByDialID = objc_getAssociatedObject(owner, callsKey);
    if (![OutboundCallsByDialID isKindOfClass:[NSMutableDictionary class]]) {
        OutboundCallsByDialID = [NSMutableDictionary dictionary];
        objc_setAssociatedObject(owner, callsKey, OutboundCallsByDialID, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    CancelledOutboundDialIDs = objc_getAssociatedObject(owner, cancelledKey);
    if (![CancelledOutboundDialIDs isKindOfClass:[NSMutableSet class]]) {
        CancelledOutboundDialIDs = [NSMutableSet set];
        objc_setAssociatedObject(owner, cancelledKey, CancelledOutboundDialIDs, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
}

static void ArmOutboundCancellation(NSString *dialID) {
    if (dialID.length == 0) {
        return;
    }
    [CancelledOutboundDialIDs addObject:dialID];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [CancelledOutboundDialIDs removeObject:dialID];
        [OutboundCallsByDialID removeObjectForKey:dialID];
    });
}

static BOOL CallsShareCarrierIdentity(TUCall *first, TUCall *second) {
    if (first == nil || second == nil) {
        return NO;
    }
    if (first == second) {
        return YES;
    }
    NSString *firstUUID = [first callUUID];
    NSString *secondUUID = [second callUUID];
    if (firstUUID.length > 0 && [firstUUID isEqualToString:secondUUID]) {
        return YES;
    }
    // Apple can replace the provisional TUCall object before assigning its
    // UUID. Its own proxy identity links those objects; it is not our dial ID.
    NSString *firstProxyID = [first uniqueProxyIdentifier];
    NSString *secondProxyID = [second uniqueProxyIdentifier];
    if (firstProxyID.length > 0 && [firstProxyID isEqualToString:secondProxyID]) {
        return YES;
    }
    // TelephonyUtilities links provisional and carrier TUCall objects through
    // comparativeCall even when it replaces both public identity values.
    return [first comparativeCall] == second || [second comparativeCall] == first;
}

static NSArray<TUCall *> *AllKnownCalls(void) {
    TUCallCenter *callCenter = [TUCallCenter sharedInstance];
    NSMutableArray<TUCall *> *calls = [NSMutableArray array];
    NSArray *callLists = @[
        [callCenter currentCalls] ?: @[],
        [callCenter currentAudioAndVideoCalls] ?: @[],
        [callCenter displayedCalls] ?: @[],
        [callCenter displayedAudioAndVideoCalls] ?: @[],
        [callCenter incomingCalls] ?: @[],
    ];
    for (NSArray *callList in callLists) {
        for (TUCall *call in callList) {
            if (![calls containsObject:call]) {
                [calls addObject:call];
            }
        }
    }
    for (id candidate in @[[callCenter incomingCall] ?: [NSNull null], [callCenter incomingVideoCall] ?: [NSNull null]]) {
        if (candidate != [NSNull null] && ![calls containsObject:candidate]) {
            [calls addObject:candidate];
        }
    }
    return calls;
}

static NSString *RetainedDialIDForOutboundCall(TUCall *call) {
    for (NSString *dialID in OutboundCallsByDialID) {
        TUCall *retainedCall = OutboundCallsByDialID[dialID];
        if (CallsShareCarrierIdentity(retainedCall, call)) {
            return dialID;
        }
    }
    return nil;
}

static TUCall *LiveOutboundCall(NSString *dialID, NSString *expectedCallUUID, NSString *expectedProxyIdentifier) {
    TUCall *retainedCall = dialID.length > 0 ? OutboundCallsByDialID[dialID] : nil;
    for (TUCall *call in AllKnownCalls()) {
        BOOL matchesRetainedCall = CallsShareCarrierIdentity(retainedCall, call);
        BOOL matchesExpectedUUID = expectedCallUUID.length > 0 && [[call callUUID] isEqualToString:expectedCallUUID];
        BOOL matchesExpectedProxyIdentifier = expectedProxyIdentifier.length > 0 &&
            [[call uniqueProxyIdentifier] isEqualToString:expectedProxyIdentifier];
        if ([call isOutgoing] && (matchesRetainedCall || matchesExpectedUUID || matchesExpectedProxyIdentifier)) {
            if (dialID.length > 0) {
                OutboundCallsByDialID[dialID] = call;
            }
            return call;
        }
    }
    return nil;
}

static void ReleaseRetainedOutboundCall(TUCall *call) {
    if (call == nil) {
        return;
    }
    for (NSString *dialID in [OutboundCallsByDialID allKeys]) {
        TUCall *retainedCall = OutboundCallsByDialID[dialID];
        if (CallsShareCarrierIdentity(retainedCall, call)) {
            if (![CancelledOutboundDialIDs containsObject:dialID]) {
                [OutboundCallsByDialID removeObjectForKey:dialID];
            }
        }
    }
}

@interface FACETIMEHELPER : NSObject
+ (instancetype)sharedInstance;
@end

FACETIMEHELPER *plugin;

@implementation FACETIMEHELPER

// FACETIMEHELPER is a singleton
+ (instancetype)sharedInstance {
    static FACETIMEHELPER *plugin = nil;
    @synchronized(self) {
        if (!plugin) {
            plugin = [[self alloc] init];
        }
    }
    return plugin;
}

// Called when macforge initializes the plugin
+ (void)load {
    // Create the singleton
    plugin = [FACETIMEHELPER sharedInstance];
    // Store ownership on a host object whose lifetime spans helper reinjection.
    // Static dictionaries alone would orphan provisional outbound calls.
    RestoreOutboundState();

    // Get OS version for debugging purposes
    NSUInteger major = [[NSProcessInfo processInfo] operatingSystemVersion].majorVersion;
    NSUInteger minor = [[NSProcessInfo processInfo] operatingSystemVersion].minorVersion;
    DLog("FACETIMEHELPER: %{public}@ loaded into %{public}@ on macOS %ld.%ld", [self className], [[NSBundle mainBundle] bundleIdentifier], (long)major, (long)minor);

    NSString *bundleIdentifier = [[NSBundle mainBundle] bundleIdentifier];
    if ([bundleIdentifier isEqualToString:@"com.apple.FaceTime"] ||
        [bundleIdentifier isEqualToString:@"com.apple.FaceTime.FTConversationService"] ||
        [bundleIdentifier isEqualToString:@"com.apple.mobilephone"] ||
        [bundleIdentifier isEqualToString:@"com.apple.TelephonyUtilities"]) {
        DLog("FACETIMEHELPER: Initializing Connection...");
        [plugin initializeNetworkController];
    } else {
        DLog("FACETIMEHELPER: Injected into unsupported call process %@, aborting.", bundleIdentifier);
        return;
    }
}

// Private method to initialize all the things required by the plugin to communicate with the main
// server over a tcp socket
-(void) initializeNetworkController {
    // Get the network controller
    NetworkController *controller = [NetworkController sharedInstance];
    controller.messageReceivedBlock =  ^(NetworkController *controller, NSString *data) {
        [self handleMessage:controller message: data];
    };
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(callStatusChanged:) name:@"TUCallCenterVideoCallStatusChangedNotification" object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(callStatusChanged:) name:@"TUCallCenterCallStatusChangedNotification" object:nil];
    [self pollCallStatuses];
    ConnectionAuthenticator = [[OpenClawFaceTimeConnectionAuthenticator alloc]
        initWithToken:[NSString stringWithUTF8String:OPENCLAW_FACETIME_HELPER_TOKEN]];
    controller.connectionReadyBlock = ^(NetworkController *readyController) {
        NSString *bundleIdentifier = [[NSBundle mainBundle] bundleIdentifier] ?: @"";
        NSDictionary *hello = [ConnectionAuthenticator
            beginWithBundleIdentifier:bundleIdentifier
            buildID:[NSString stringWithUTF8String:OPENCLAW_FACETIME_HELPER_BUILD_ID]
            processID:@(getpid())
            processStartedAtMs:ProcessStartedAtMilliseconds()];
        if (hello == nil) {
            [readyController failConnection];
            return;
        }
        [readyController sendControlMessage:hello];
    };
    [controller connect];
}

-(void) emitCallStatus:(id)call {
    if (call == nil || ![call respondsToSelector:@selector(callUUID)] || ![call respondsToSelector:@selector(callStatus)]) {
        return;
    }
    NSString *dialID = RetainedDialIDForOutboundCall(call);
    if (dialID.length > 0 && [CancelledOutboundDialIDs containsObject:dialID]) {
        // A cancellation can arrive before TelephonyUtilities publishes the
        // call. Suppress that late carrier object before the bridge sees it.
        [[TUCallCenter sharedInstance] disconnectCall:call];
        ReleaseRetainedOutboundCall(call);
        return;
    }
    TUConversation *conversation = [[TUCallCenter sharedInstance] activeConversationForCall:call];
    NSMutableDictionary *data = [@{
        @"audio_mode": [call audioMode] ?: [NSNull null],
        @"call_status": [NSNumber numberWithInt:[call callStatus]] ?: [NSNull null],
        @"call_uuid": [call callUUID] ?: [NSNull null],
        @"proxy_identifier": [call uniqueProxyIdentifier] ?: [NSNull null],
        @"conversation_uuid": [[conversation UUID] UUIDString] ?: [NSNull null],
        @"conversation_group_uuid": [[conversation groupUUID] UUIDString] ?: [NSNull null],
        @"conversation_audio_enabled": [NSNumber numberWithBool:[conversation isAudioEnabled]] ?: [NSNull null],
        @"conversation_video_enabled": [NSNumber numberWithBool:[conversation isVideoEnabled]] ?: [NSNull null],
        @"conversation_av_mode": [NSNumber numberWithUnsignedInteger:[conversation avMode]] ?: [NSNull null],
        @"conversation_resolved_audio_video_mode": [NSNumber numberWithUnsignedInteger:[conversation resolvedAudioVideoMode]] ?: [NSNull null],
        @"is_conversation": [NSNumber numberWithBool:[call isConversation]] ?: [NSNull null],
        @"is_endpoint_on_current_device": [NSNumber numberWithBool:[call isEndpointOnCurrentDevice]] ?: [NSNull null],
        @"is_hosted_on_current_device": [NSNumber numberWithBool:[call isHostedOnCurrentDevice]] ?: [NSNull null],
        @"disconnected_reason": [NSNumber numberWithInt:[call disconnectedReason]] ?: [NSNull null],
        @"ended_error": [call endedErrorString] ?: [NSNull null],
        @"ended_reason": [call endedReasonString] ?: [NSNull null],
        @"has_ended": @([call dateEnded] != nil),
        @"transport": CallTransportEvidence(call),
        @"handle": [[call handle] dictionaryRepresentation] ?: [NSNull null],
        @"is_sending_audio": [NSNumber numberWithBool:[call isSendingAudio]] ?: [NSNull null],
        @"is_sending_transmission": [NSNumber numberWithBool:[call isSendingTransmission]] ?: [NSNull null],
        @"is_sending_video": [NSNumber numberWithBool:[call isSendingVideo]] ?: [NSNull null],
        @"is_uplink_muted": [NSNumber numberWithBool:[call isUplinkMuted]] ?: [NSNull null],
        @"is_outgoing": [NSNumber numberWithBool:[call isOutgoing]] ?: [NSNull null],
        @"local_meter_level": [NSNumber numberWithFloat:[call localMeterLevel]] ?: [NSNull null],
        @"remote_meter_level": [NSNumber numberWithFloat:[call remoteMeterLevel]] ?: [NSNull null],
    } mutableCopy];
    if (dialID.length > 0) {
        data[@"dial_id"] = dialID;
    }
    NSDictionary *message = @{@"event": @"ft-call-status-changed", @"data": data};
    [[NetworkController sharedInstance] sendMessage: message];
}

-(NSDictionary*) startConversationAudioForCall:(TUCall*)call muted:(BOOL)muted preserveVideo:(BOOL)preserveVideo {
    NSMutableDictionary *result = [NSMutableDictionary dictionary];
    TUConversation *conversation = [[TUCallCenter sharedInstance] activeConversationForCall:call];
    NSUUID *conversationUUID = [conversation UUID];
    BOOL videoActive = preserveVideo || [conversation isVideoEnabled] || [call isSendingVideo];
    result[@"conversation_uuid"] = [conversationUUID UUIDString] ?: [NSNull null];
    result[@"conversation_group_uuid"] = [[conversation groupUUID] UUIDString] ?: [NSNull null];

    if (conversationUUID == nil) {
        result[@"conversation_audio_started"] = @NO;
        result[@"conversation_audio_error"] = @"No active conversation UUID";
        return result;
    }

    Class conversationManagerClass = NSClassFromString(@"CSDConversationManager");
    id conversationManager = [[conversationManagerClass alloc] init];
    BOOL didSetUplinkMuted = NO;
    BOOL didSetPendingUplinkMuted = NO;
    BOOL didSetAudioPaused = NO;
    BOOL didStartAudio = NO;
    BOOL didSetConversationAudioEnabled = NO;
    BOOL didSetConversationAVMode = NO;
    BOOL didSetLocalParticipantMode = NO;
    BOOL didSetLocalParticipantModeViaXPC = NO;
    BOOL didSetSendingAudio = NO;

    if ([conversation respondsToSelector:@selector(setAudioEnabled:)]) {
        [conversation setAudioEnabled:!muted];
        didSetConversationAudioEnabled = YES;
    }
    if (!muted && !videoActive && [conversation respondsToSelector:@selector(setAvMode:)]) {
        [conversation setAvMode:1];
        didSetConversationAVMode = YES;
    }

    if ([conversationManager respondsToSelector:@selector(setUplinkMuted:forConversationWithUUID:)]) {
        void (*setUplinkMuted)(id, SEL, BOOL, id) = (void (*)(id, SEL, BOOL, id))[conversationManager methodForSelector:@selector(setUplinkMuted:forConversationWithUUID:)];
        setUplinkMuted(conversationManager, @selector(setUplinkMuted:forConversationWithUUID:), muted, conversationUUID);
        didSetUplinkMuted = YES;
    }
    if ([conversationManager respondsToSelector:@selector(setUplinkMuted:forPendingConversationWithUUID:)]) {
        void (*setPendingUplinkMuted)(id, SEL, BOOL, id) = (void (*)(id, SEL, BOOL, id))[conversationManager methodForSelector:@selector(setUplinkMuted:forPendingConversationWithUUID:)];
        setPendingUplinkMuted(conversationManager, @selector(setUplinkMuted:forPendingConversationWithUUID:), muted, conversationUUID);
        didSetPendingUplinkMuted = YES;
    }
    if (!muted && [conversationManager respondsToSelector:@selector(setAudioPaused:forConversationWithUUID:)]) {
        void (*setAudioPaused)(id, SEL, BOOL, id) = (void (*)(id, SEL, BOOL, id))[conversationManager methodForSelector:@selector(setAudioPaused:forConversationWithUUID:)];
        setAudioPaused(conversationManager, @selector(setAudioPaused:forConversationWithUUID:), NO, conversationUUID);
        didSetAudioPaused = YES;
    }
    if (!muted && [conversationManager respondsToSelector:@selector(startAudioForConversationWithUUID:)]) {
        void (*startAudio)(id, SEL, id) = (void (*)(id, SEL, id))[conversationManager methodForSelector:@selector(startAudioForConversationWithUUID:)];
        startAudio(conversationManager, @selector(startAudioForConversationWithUUID:), conversationUUID);
        didStartAudio = YES;
    }
    if (!muted) {
        if ([call respondsToSelector:@selector(setIsSendingAudio:)]) {
            ((void (*)(id, SEL, BOOL))[call methodForSelector:@selector(setIsSendingAudio:)])(
                call,
                @selector(setIsSendingAudio:),
                YES
            );
            didSetSendingAudio = YES;
        }
        // Mode 1 is the helper's audio-only fallback. Preserve an existing
        // FaceTime video mode while changing only the call's audio route.
        if (!videoActive) {
            TUConversationManager *tuConversationManager = [[TUConversationManager alloc] init];
            if ([tuConversationManager respondsToSelector:@selector(setLocalParticipantAudioVideoMode:forConversationUUID:)]) {
                [tuConversationManager setLocalParticipantAudioVideoMode:1 forConversationUUID:conversationUUID];
                didSetLocalParticipantMode = YES;
            }
            TUConversationManagerXPCClient *xpcClient = [[TUConversationManagerXPCClient alloc] init];
            if ([xpcClient respondsToSelector:@selector(setLocalParticipantAudioVideoMode:forConversationUUID:)]) {
                [xpcClient setLocalParticipantAudioVideoMode:1 forConversationUUID:conversationUUID];
                didSetLocalParticipantModeViaXPC = YES;
            }
        }
    }

    result[@"conversation_audio_enabled"] = [NSNumber numberWithBool:[conversation isAudioEnabled]];
    result[@"conversation_video_enabled"] = [NSNumber numberWithBool:[conversation isVideoEnabled]];
    result[@"conversation_av_mode"] = [NSNumber numberWithUnsignedInteger:[conversation avMode]];
    result[@"conversation_resolved_audio_video_mode"] = [NSNumber numberWithUnsignedInteger:[conversation resolvedAudioVideoMode]];
    result[@"conversation_audio_enabled_set"] = [NSNumber numberWithBool:didSetConversationAudioEnabled];
    result[@"conversation_av_mode_set"] = [NSNumber numberWithBool:didSetConversationAVMode];
    result[@"conversation_uplink_muted_set"] = [NSNumber numberWithBool:didSetUplinkMuted];
    result[@"pending_conversation_uplink_muted_set"] = [NSNumber numberWithBool:didSetPendingUplinkMuted];
    result[@"conversation_audio_paused_cleared"] = [NSNumber numberWithBool:didSetAudioPaused];
    result[@"conversation_audio_started"] = [NSNumber numberWithBool:didStartAudio];
    result[@"local_participant_audio_video_mode_set"] = [NSNumber numberWithBool:didSetLocalParticipantMode];
    result[@"local_participant_audio_video_mode_xpc_set"] = [NSNumber numberWithBool:didSetLocalParticipantModeViaXPC];
    result[@"is_sending_audio_set"] = [NSNumber numberWithBool:didSetSendingAudio];
    return result;
}

-(void) pollCallStatuses {
    TUCallCenter *callCenter = [TUCallCenter sharedInstance];
    NSMutableDictionary *callsByUUID = [NSMutableDictionary dictionary];
    NSArray *callLists = @[
        [callCenter currentCalls] ?: @[],
        [callCenter currentAudioAndVideoCalls] ?: @[],
        [callCenter displayedCalls] ?: @[],
        [callCenter displayedAudioAndVideoCalls] ?: @[],
        [callCenter incomingCalls] ?: @[],
    ];
    for (NSArray *callList in callLists) {
        for (id call in callList) {
            if ([call respondsToSelector:@selector(callUUID)] && [call callUUID] != nil) {
                callsByUUID[[call callUUID]] = call;
            }
        }
    }
    id incomingCall = [callCenter incomingCall];
    if (incomingCall != nil && [incomingCall respondsToSelector:@selector(callUUID)] && [incomingCall callUUID] != nil) {
        callsByUUID[[incomingCall callUUID]] = incomingCall;
    }
    id incomingVideoCall = [callCenter incomingVideoCall];
    if (incomingVideoCall != nil && [incomingVideoCall respondsToSelector:@selector(callUUID)] && [incomingVideoCall callUUID] != nil) {
        callsByUUID[[incomingVideoCall callUUID]] = incomingVideoCall;
    }
    for (id callUUID in callsByUUID) {
        [self emitCallStatus:callsByUUID[callUUID]];
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^(void){
        [self pollCallStatuses];
    });
}

-(void) callStatusChanged: (NSNotification *)notification {
    TUCall *call = [notification object];
    NSString *dialID = RetainedDialIDForOutboundCall(call);
    [self emitCallStatus:call];
    int status = [call callStatus];
    if (status != 0 && status != 1 && status != 3 && status != 4) {
        ReleaseRetainedOutboundCall(call);
        if (dialID.length > 0) {
            [CancelledOutboundDialIDs removeObject:dialID];
        }
    }
}

// Run when receiving a new message from the tcp socket
-(void) handleMessage: (NetworkController*)controller  message:(NSString *)message {
    NSError *error;
    NSData *jsonData = [message dataUsingEncoding:NSUTF8StringEncoding];
    id decoded = [NSJSONSerialization JSONObjectWithData:jsonData options:kNilOptions error:&error];
    if (![decoded isKindOfClass:[NSDictionary class]]) {
        [controller failConnection];
        return;
    }
    NSDictionary *dictionary = decoded;

    NSString *controlEvent = [dictionary[@"event"] isKindOfClass:[NSString class]]
        ? dictionary[@"event"]
        : @"";
    if ([controlEvent isEqualToString:@"server-hello"]) {
        NSDictionary *finish = [ConnectionAuthenticator consumeServerHello:dictionary];
        if (finish == nil) {
            [controller failConnection];
            return;
        }
        [controller sendControlMessage:finish];
        return;
    }

    NSDictionary *authenticatedPayload =
        [ConnectionAuthenticator consumeIncomingEnvelope:dictionary];
    if (authenticatedPayload == nil) {
        [controller failConnection];
        return;
    }
    dictionary = authenticatedPayload;
    controlEvent = [dictionary[@"event"] isKindOfClass:[NSString class]]
        ? dictionary[@"event"]
        : @"";
    if ([controlEvent isEqualToString:@"session-ready"]) {
        controller.outgoingTransformBlock = ^NSDictionary *(NSDictionary *payload) {
            return [ConnectionAuthenticator protectOutgoingPayload:payload];
        };
        [controller sendMessage:@{@"event": @"session-ready-ack"}];
        return;
    }

    NSString *event = dictionary[@"action"];
    NSDictionary *data = dictionary[@"data"];
    NSString *transaction = nil;
    if ([dictionary[@"transactionId"] isKindOfClass:[NSString class]]) {
        transaction = dictionary[@"transactionId"];
    }
    if (![event isKindOfClass:[NSString class]] || event.length == 0 ||
        ![data isKindOfClass:[NSDictionary class]] || transaction.length == 0) {
        [controller failConnection];
        return;
    }

    DLog("FACETIMEHELPER: Authenticated action received: %{public}@", event);

    if ([event isEqualToString:@"answer-call"]) {
        TUCall *call = [[TUCallCenter sharedInstance] callWithCallUUID:(data[@"callUUID"])];

        if (call == nil) {
            if (transaction != nil) {
                [controller sendMessage: @{@"transactionId": transaction, @"outcome": @"absent", @"found": @NO}];
            }
            return;
        }
        if ([call callStatus] != 4) {
            if (transaction != nil) {
                [controller sendMessage: @{@"transactionId": transaction, @"error": @"Call is not waiting to be answered!"}];
            }
            return;
        }
        if (!IsVerifiedFaceTimeCall(call)) {
            if (transaction != nil) {
                [controller sendMessage: @{
                    @"transactionId": transaction,
                    @"error": @"Call transport is not verified FaceTime",
                    @"transport": CallTransportEvidence(call),
                }];
            }
            return;
        }

        // Keep the uplink closed until the Node bridge verifies that this exact
        // call process is using OpenClaw-Mic. This prevents a physical-mic leak
        // during the short interval between answer and Core Audio route setup.
        [call setMuted:YES];
        [call setUplinkMuted:YES];
        TUConversation *conversation = [[TUCallCenter sharedInstance] activeConversationForCall:call];
        NSUUID *conversationUUID = [conversation UUID];
        if (conversationUUID != nil) {
            TUConversationManager *conversationManager = [[TUConversationManager alloc] init];
            if ([conversationManager respondsToSelector:@selector(setUplinkMuted:forPendingConversationWithUUID:)]) {
                void (*setPendingUplinkMuted)(id, SEL, BOOL, id) = (void (*)(id, SEL, BOOL, id))[conversationManager methodForSelector:@selector(setUplinkMuted:forPendingConversationWithUUID:)];
                setPendingUplinkMuted(conversationManager, @selector(setUplinkMuted:forPendingConversationWithUUID:), YES, conversationUUID);
            }
        }
        if (![call isMuted] || ![call isUplinkMuted]) {
            if (transaction != nil) {
                [controller sendMessage: @{
                    @"transactionId": transaction,
                    @"error": @"FaceTime did not confirm a muted uplink before answer",
                    @"muted": @([call isMuted]),
                    @"is_uplink_muted": @([call isUplinkMuted]),
                }];
            }
            return;
        }
        [[TUCallCenter sharedInstance] answerOrJoinCall:call];
        if (transaction != nil) {
            [controller sendMessage: @{
                @"transactionId": transaction,
                @"outcome": @"answered-muted",
                @"muted": @([call isMuted]),
                @"is_uplink_muted": @([call isUplinkMuted]),
            }];
        }
    } else if ([event isEqualToString:@"leave-call"]) {
        TUCall *call = [[TUCallCenter sharedInstance] callWithCallUUID:(data[@"callUUID"])];

        if (call == nil) {
            if (transaction != nil) {
                [controller sendMessage: @{@"transactionId": transaction, @"outcome": @"absent", @"found": @NO}];
            }
            return;
        }

        // Outbound dialing can still be ringing when shutdown needs to cancel it.
        // TUCallCenter owns disconnection for every live call status.
        [[TUCallCenter sharedInstance] disconnectCall:call];
        if (transaction != nil) {
            [controller sendMessage: @{
                @"transactionId": transaction,
                @"outcome": @"termination-requested",
                @"call_uuid": [call callUUID] ?: [NSNull null],
            }];
        }
    } else if ([event isEqualToString:@"inspect-call"]) {
        NSArray *aliases = [data[@"callUUIDs"] isKindOfClass:[NSArray class]]
            ? data[@"callUUIDs"]
            : @[];
        TUCall *matchedCall = nil;
        for (id alias in aliases) {
            if (![alias isKindOfClass:[NSString class]]) {
                continue;
            }
            matchedCall = [[TUCallCenter sharedInstance] callWithCallUUID:alias];
            if (matchedCall != nil) {
                break;
            }
        }
        if (transaction != nil) {
            [controller sendMessage: @{
                @"transactionId": transaction,
                @"outcome": matchedCall == nil ? @"absent" : @"present",
                @"found": @(matchedCall != nil),
                @"call_uuid": [matchedCall callUUID] ?: [NSNull null],
                @"call_status": matchedCall == nil ? [NSNull null] : @([matchedCall callStatus]),
            }];
        }
    } else if ([event isEqualToString:@"safety-mute"]) {
        TUCall *call = [[TUCallCenter sharedInstance] callWithCallUUID:(data[@"callUUID"])];
        if (call == nil) {
            if (transaction != nil) {
                [controller sendMessage: @{@"transactionId": transaction, @"outcome": @"absent", @"found": @NO}];
            }
            return;
        }
        [call setDownlinkMuted:YES];
        [call setMuted:YES];
        [call setUplinkMuted:YES];
        if (transaction != nil) {
            [controller sendMessage: @{
                @"transactionId": transaction,
                @"outcome": @"safe-muted",
                @"downlink_muted": [NSNumber numberWithBool:[call isDownlinkMuted]],
                @"muted": [NSNumber numberWithBool:[call isMuted]],
                @"is_uplink_muted": [NSNumber numberWithBool:[call isUplinkMuted]],
            }];
        }
    } else if ([event isEqualToString:@"set-muted"]) {
        TUCall *call = [[TUCallCenter sharedInstance] callWithCallUUID:(data[@"callUUID"])];

        if (call == nil) {
            if (transaction != nil) {
                [controller sendMessage: @{@"transactionId": transaction, @"outcome": @"absent", @"found": @NO}];
            }
            return;
        }

        BOOL muted = [data[@"muted"] boolValue];
        if (!muted && !IsVerifiedFaceTimeCall(call)) {
            if (transaction != nil) {
                [controller sendMessage: @{
                    @"transactionId": transaction,
                    @"error": @"Call transport is not verified FaceTime",
                    @"transport": CallTransportEvidence(call),
                }];
            }
            return;
        }
        BOOL didSetMuted = [call setMuted:muted];
        [call setUplinkMuted:muted];
        NSDictionary *conversationAudioResult = [self startConversationAudioForCall:call muted:muted preserveVideo:NO];
        if (transaction != nil) {
            NSMutableDictionary *response = [@{
                @"transactionId": transaction,
                @"outcome": muted ? @"safe-muted" : @"media-configured",
                @"muted": [NSNumber numberWithBool:[call isMuted]],
                @"is_sending_audio": [NSNumber numberWithBool:[call isSendingAudio]],
                @"is_sending_transmission": [NSNumber numberWithBool:[call isSendingTransmission]],
                @"is_uplink_muted": [NSNumber numberWithBool:[call isUplinkMuted]],
                @"ok": [NSNumber numberWithBool:didSetMuted],
            } mutableCopy];
            [response addEntriesFromDictionary:conversationAudioResult];
            [controller sendMessage: response];
        }
    } else if ([event isEqualToString:@"start-transmission"]) {
        TUCall *call = [[TUCallCenter sharedInstance] callWithCallUUID:(data[@"callUUID"])];

        if (call == nil) {
            if (transaction != nil) {
                [controller sendMessage: @{@"transactionId": transaction, @"outcome": @"absent", @"found": @NO}];
            }
            return;
        }
        if (!IsVerifiedFaceTimeCall(call)) {
            if (transaction != nil) {
                [controller sendMessage: @{
                    @"transactionId": transaction,
                    @"error": @"Call transport is not verified FaceTime",
                    @"transport": CallTransportEvidence(call),
                }];
            }
            return;
        }

        [call setUplinkMuted:NO];
        TUConversation *conversation = [[TUCallCenter sharedInstance] activeConversationForCall:call];
        BOOL wasSendingVideo = [call isSendingVideo];
        BOOL preserveVideo = [conversation isVideoEnabled] || wasSendingVideo;
        NSUInteger videoMode = [conversation avMode];
        [[TUCallCenter sharedInstance] startTransmissionForBargeCall:call sourceIsHandsfreeAccessory:NO];
        // Barge transmission activates FaceTime's local speaking telemetry. It
        // can also reset an active video conversation, so restore its prior mode.
        if (preserveVideo) {
            NSUUID *conversationUUID = [conversation UUID];
            if ([conversation respondsToSelector:@selector(setAvMode:)]) {
                [conversation setAvMode:videoMode];
            }
            // Only restore the local participant's video mode when the camera
            // was already sending. A receive-only video call may have camera off.
            if (wasSendingVideo) {
                TUConversationManager *manager = [[TUConversationManager alloc] init];
                if ([manager respondsToSelector:@selector(setLocalParticipantAudioVideoMode:forConversationUUID:)]) {
                    [manager setLocalParticipantAudioVideoMode:videoMode forConversationUUID:conversationUUID];
                }
                TUConversationManagerXPCClient *xpcClient = [[TUConversationManagerXPCClient alloc] init];
                if ([xpcClient respondsToSelector:@selector(setLocalParticipantAudioVideoMode:forConversationUUID:)]) {
                    [xpcClient setLocalParticipantAudioVideoMode:videoMode forConversationUUID:conversationUUID];
                }
            }
        }
        NSDictionary *conversationAudioResult = [self startConversationAudioForCall:call muted:NO preserveVideo:preserveVideo];
        if (transaction != nil) {
            NSMutableDictionary *response = [@{
                @"transactionId": transaction,
                @"outcome": @"media-active",
                @"muted": [NSNumber numberWithBool:[call isMuted]],
                @"is_sending_audio": [NSNumber numberWithBool:[call isSendingAudio]],
                @"is_sending_transmission": [NSNumber numberWithBool:[call isSendingTransmission]],
                @"is_uplink_muted": [NSNumber numberWithBool:[call isUplinkMuted]],
            } mutableCopy];
            [response addEntriesFromDictionary:conversationAudioResult];
            [controller sendMessage: response];
        }
    } else if ([event isEqualToString:@"start-call"]) {
        NSString *handle = [data[@"handle"] isKindOfClass:[NSString class]] ? data[@"handle"] : nil;
        NSString *mode = [data[@"mode"] isKindOfClass:[NSString class]] ? data[@"mode"] : nil;
        NSString *dialID = [data[@"dialID"] isKindOfClass:[NSString class]] ? data[@"dialID"] : nil;
        if (handle.length == 0 || dialID.length == 0 || !([mode isEqualToString:@"audio"] || [mode isEqualToString:@"video"])) {
            if (transaction != nil) {
                [controller sendMessage: @{@"transactionId": transaction, @"error": @"Valid handle, mode, and dial ID are required"}];
            }
            return;
        }

        TUCallCenter *callCenter = [TUCallCenter sharedInstance];
        if ([[callCenter currentCalls] count] > 0) {
            if (transaction != nil) {
                [controller sendMessage: @{@"transactionId": transaction, @"error": @"Another call is already active"}];
            }
            return;
        }

        NSString *escapedHandle = [handle stringByAddingPercentEncodingWithAllowedCharacters:[NSCharacterSet URLPathAllowedCharacterSet]];
        NSString *scheme = [mode isEqualToString:@"video"] ? @"facetime" : @"facetime-audio";
        NSURL *URL = [NSURL URLWithString:[NSString stringWithFormat:@"%@://%@", scheme, escapedHandle]];
        Class dialRequestClass = NSClassFromString(@"TUDialRequest");
        if (URL == nil || dialRequestClass == Nil || ![dialRequestClass instancesRespondToSelector:@selector(initWithURL:)]) {
            if (transaction != nil) {
                [controller sendMessage: @{@"transactionId": transaction, @"error": @"TUDialRequest is unavailable"}];
            }
            return;
        }

        TUDialRequest *request = nil;
        @try {
            request = [[dialRequestClass alloc] initWithURL:URL];
            request.video = [mode isEqualToString:@"video"];
            request.showUIPrompt = NO;
            if ([request respondsToSelector:@selector(isValid)] && !request.valid) {
                NSString *reason = request.validityErrors.count > 0
                    ? [request.validityErrors componentsJoinedByString:@"; "]
                    : @"Dial request is invalid";
                if (transaction != nil) {
                    [controller sendMessage: @{@"transactionId": transaction, @"error": reason}];
                }
                return;
            }
            if (![callCenter respondsToSelector:@selector(dialWithRequest:)] ||
                ([callCenter respondsToSelector:@selector(canDialWithRequest:)] && ![callCenter canDialWithRequest:request])) {
                if (transaction != nil) {
                    [controller sendMessage: @{@"transactionId": transaction, @"error": @"FaceTime cannot dial this request"}];
                }
                return;
            }
        } @catch (NSException *exception) {
            if (transaction != nil) {
                [controller sendMessage: @{
                    @"transactionId": transaction,
                    @"error": exception.reason ?: @"FaceTime dial failed",
                }];
            }
            return;
        }

        TUCall *call = nil;
        @try {
            call = [callCenter dialWithRequest:request];
        } @catch (NSException *exception) {
            if (transaction != nil) {
                [controller sendMessage: @{
                    @"transactionId": transaction,
                    @"error": exception.reason ?: @"FaceTime dial outcome is unknown",
                    @"ambiguous": @YES,
                }];
            }
            return;
        }
        if (call == nil) {
            if (transaction != nil) {
                [controller sendMessage: @{@"transactionId": transaction, @"error": @"FaceTime did not create an outbound call"}];
            }
            return;
        }
        if (!ApplyOutboundSafetyMute(call)) {
            [[TUCallCenter sharedInstance] disconnectCall:call];
            if (transaction != nil) {
                [controller sendMessage: @{
                    @"transactionId": transaction,
                    @"error": @"Outbound call transport or safety mute could not be verified",
                    @"transport": CallTransportEvidence(call),
                }];
            }
            return;
        }
        OutboundCallsByDialID[dialID] = call;

        // Publish Apple's identity before the delayed acceptance check. The
        // gateway retains it across helper reinjection without overwriting the
        // reserved uniqueProxyIdentifier on TUDialRequest.
        [controller sendMessage: @{
            @"event": @"ft-outbound-call-identified",
            @"data": @{
                @"dial_id": dialID,
                @"call_uuid": [call callUUID] ?: [NSNull null],
                @"proxy_identifier": [call uniqueProxyIdentifier] ?: [NSNull null],
            },
        }];

        // CSD can discard the provisional call after dialWithRequest returns.
        // Let its state machine run before claiming that the dial was accepted.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            TUCall *stableCall = LiveOutboundCall(dialID, nil, nil);
            if (stableCall == nil) {
                if (transaction != nil) {
                    [controller sendMessage: @{
                        @"transactionId": transaction,
                        @"error": @"FaceTime ended the outbound call before it could ring",
                        @"ambiguous": @YES,
                    }];
                }
                return;
            }
            if (!ApplyOutboundSafetyMute(stableCall)) {
                [[TUCallCenter sharedInstance] disconnectCall:stableCall];
                if (transaction != nil) {
                    [controller sendMessage: @{
                        @"transactionId": transaction,
                        @"error": @"Outbound safety mute was not retained while ringing",
                        @"transport": CallTransportEvidence(stableCall),
                    }];
                }
                return;
            }
            @try {
                [self emitCallStatus:stableCall];
                if (transaction != nil) {
                    [controller sendMessage: @{
                        @"transactionId": transaction,
                        @"dial_id": dialID,
                        @"call_uuid": [stableCall callUUID] ?: [NSNull null],
                        @"proxy_identifier": [stableCall uniqueProxyIdentifier] ?: [NSNull null],
                        @"handle": handle,
                        @"mode": mode,
                        @"muted": @([stableCall isMuted]),
                        @"is_uplink_muted": @([stableCall isUplinkMuted]),
                        @"transport": CallTransportEvidence(stableCall),
                    }];
                }
            } @catch (NSException *exception) {
                DLog("FACETIMEHELPER: outbound acknowledgement failed: %{public}@", exception.reason);
            }
        });
    } else if ([event isEqualToString:@"find-outgoing-call"]) {
        NSString *dialID = [data[@"dialID"] isKindOfClass:[NSString class]] ? data[@"dialID"] : @"";
        NSString *expectedCallUUID = [data[@"callUUID"] isKindOfClass:[NSString class]]
            ? [data[@"callUUID"] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
            : @"";
        NSString *expectedProxyIdentifier = [data[@"proxyIdentifier"] isKindOfClass:[NSString class]]
            ? [data[@"proxyIdentifier"] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
            : @"";
        BOOL retainedDial = dialID.length > 0 && OutboundCallsByDialID[dialID] != nil;
        TUCall *matchedCall = LiveOutboundCall(dialID, expectedCallUUID, expectedProxyIdentifier);
        if (matchedCall != nil && !ApplyOutboundSafetyMute(matchedCall)) {
            [[TUCallCenter sharedInstance] disconnectCall:matchedCall];
            matchedCall = nil;
        }
        if (transaction != nil) {
            [controller sendMessage: @{
                @"transactionId": transaction,
                @"found": [NSNumber numberWithBool:matchedCall != nil],
                @"retained_outbound_dial": [NSNumber numberWithBool:retainedDial],
                @"call_uuid": [matchedCall callUUID] ?: [NSNull null],
                @"proxy_identifier": [matchedCall uniqueProxyIdentifier] ?: [NSNull null],
            }];
        }
    } else if ([event isEqualToString:@"cancel-outgoing-call"]) {
        NSString *dialID = [data[@"dialID"] isKindOfClass:[NSString class]] ? data[@"dialID"] : @"";
        NSString *expectedCallUUID = [data[@"callUUID"] isKindOfClass:[NSString class]]
            ? [data[@"callUUID"] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
            : @"";
        NSString *expectedProxyIdentifier = [data[@"proxyIdentifier"] isKindOfClass:[NSString class]]
            ? [data[@"proxyIdentifier"] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
            : @"";
        BOOL retainedDial = dialID.length > 0 && OutboundCallsByDialID[dialID] != nil;
        if (retainedDial) {
            // Arm first so LiveOutboundCall keeps the helper-owned mapping if
            // CallServices has not published the corresponding call yet.
            ArmOutboundCancellation(dialID);
        }
        TUCall *matchedCall = LiveOutboundCall(dialID, expectedCallUUID, expectedProxyIdentifier);
        if (matchedCall != nil) {
            if (!retainedDial && dialID.length > 0) {
                ArmOutboundCancellation(dialID);
            }
            [[TUCallCenter sharedInstance] disconnectCall:matchedCall];
        }
        BOOL tombstoned = retainedDial && matchedCall == nil;
        BOOL cancelled = matchedCall != nil || tombstoned;
        if (transaction != nil) {
            [controller sendMessage: @{
                @"transactionId": transaction,
                @"found": [NSNumber numberWithBool:matchedCall != nil],
                @"cancelled": [NSNumber numberWithBool:cancelled],
                @"tombstoned": [NSNumber numberWithBool:tombstoned],
                @"call_uuid": [matchedCall callUUID] ?: [NSNull null],
                @"proxy_identifier": [matchedCall uniqueProxyIdentifier] ?: [NSNull null],
            }];
        }
    }
}

@end
