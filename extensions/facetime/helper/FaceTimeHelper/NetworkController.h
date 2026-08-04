//
//  NetworkController.h
//  FaceTimeHelper
//
//  Created by Samer Shihabi on 11/20/20.
//  OpenClaw FaceTime helper.
//  Adapted and modified from the Apache-2.0 BlueBubbles helper.
//  See THIRD_PARTY_NOTICES.md.
//

#ifndef NetworkController_h
#define NetworkController_h
#import <Foundation/Foundation.h>

// Block typedefs
typedef void (^MessageBlock)(id,NSString*);
typedef void (^ConnectionReadyBlock)(id);
typedef NSDictionary* (^OutgoingTransformBlock)(NSDictionary*);

@interface NetworkController : NSObject<NSStreamDelegate>

// Singleton instance
+ (NetworkController*)sharedInstance;

// Methods
- (void)connect;
- (void)disconnect;
- (void)sendMessage:(NSDictionary*)message;
- (void)sendControlMessage:(NSDictionary*)message;
- (void)failConnection;

@property (copy) MessageBlock messageReceivedBlock;
@property (copy) ConnectionReadyBlock connectionReadyBlock;
@property (copy) OutgoingTransformBlock outgoingTransformBlock;

@end
#endif /* NetworkController_h */
