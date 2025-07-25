// import and create an alias
import { Constants as C } from './constants'
import { ViscaTransport } from './transport';
import * as utils from './utils'
import * as Parsers from './parsers'
import { CamImageData, CamLensData, CamWideDParams, PTSpeed, PTPos, PTStatus } from './camera';


// See related documentation:
// https://ptzoptics.com/wp-content/uploads/2014/09/PTZOptics-VISCA-over-IP-Commands-Rev1_0-5-18.pdf
// https://www.epiphan.com/userguides/LUMiO12x/Content/UserGuides/PTZ/3-operation/VISCAcommands.htm
// https://support.huawei.com/enterprise/en/doc/EDOC1000129687/8d49f1bf/visca-control-commands
// and from the Sony EVI H100S User Manual
// https://pro.sony/en_BA/support-resources/evi-h100s/manual
// https://manualsbrain.com/en/manuals/1047691/
//
// |------packet (3-16 bytes)---------|
// header     message        terminator
// (1 byte)   (1-14 bytes)     (1 byte)
// | X | X . . . . .  . . . . . X | X |

// HEADER:
// addressed header
// header bits:                  terminator:
// 1 s2 s1 s0 0 r2 r1 r0         0xff
// with r,s = recipient, sender msb first (big endian for bytes and bits)
//
// broadcast header is always 0x88!

// CONTROL MESSAGE FORMAT
// QQ RR ...
// QQ = 0x01 (Command) or 0x09 (Inquiry)
// RR = 0x00 (interface), 0x04 (camera), 0x06 (pan/tilt), 0x7(d|e) other
// ... data

// REPLY MESSAGE FORMAT
// Camera responses come in three types
// COMMAND ACK:      header 0x4y      0xff -- command accepted, y = socket (index of command in buffer)
// COMMAND COMPLETE: header 0x5y      0xff -- command executed, y = socket (index of buffered command)
// INQUIRY COMPLETE: header 0x50 data 0xff -- inquiry response data
export interface ViscaCommandParams {
	description?: string;
	source?: number;
	recipient?: any;
	broadcast?: boolean;
	msgType?: number;
	socket?: number;
	dataType?: number;
	data?: number[];
	onComplete?: Function;
	onError?: (x:string)=>void;
	onAck?: Function;
	dataParser?: (x:number[])=>any;
	status?: number;
}

export class ViscaCommand {
	source: number;
	recipient: any;
	broadcast: boolean;
	msgType: number;
	socket: number;
	dataType: number;
	data: number[];
	packetHexString: string = '';
	status: number;
	description: string = '';

	dataParser: (x:number[])=>any;
	onAck?: Function;
	onComplete?: Function;
	onError?: (x:string)=>void;

	// local metadata
	addedAt!: number;
	sentAt!: number;

	constructor( {
		// header items
		source = 0,
		recipient = -1,
		broadcast = true,

		description = '',

		// message type (QQ in the spec)
		msgType = C.MSGTYPE_COMMAND,
		socket = 0,

		// data might be empty
		dataType = 0,
		data = [],

		// callback functions
		onComplete = undefined,
		onError = undefined,
		onAck = undefined,
		dataParser = Parsers.NoParser.parse,
	}: ViscaCommandParams ) {

		this.description = description

		// header items
		this.source = source
		this.recipient = recipient
		this.broadcast = broadcast

		// message type is the QQ in the spec
		this.msgType = msgType
		this.socket = socket

		// data might be empty
		this.dataType = dataType
		this.data = data
		this.onComplete = onComplete;
		this.onError = onError;
		this.onAck = onAck;
		this.dataParser = dataParser;
		this.status = 0;

		this.packetHexString = this._hexify(this.toPacket());
	}

	// private methods
	_header() {
		let header = 0x88;
		// recipient overrides broadcast
		if ( this.recipient > -1 ) this.broadcast = false;
		if ( !this.broadcast ) {
			header = 0b10000000 | ( this.source << 4 ) | ( this.recipient & 0x111 );
		}
		return header;
	}

	_hexify( data: number[] ) : string {
		let hex = []
		for (let n of data) hex.push(n.toString(16));
		return hex.join(' ');
	}

	_parsePacket( packet: number[] ) {
		this.packetHexString = this._hexify(packet);

		let header = packet[ 0 ];
		this.source = ( header & C.HEADERMASK_SOURCE ) >> 4
		this.recipient = header & C.HEADERMASK_RECIPIENT; // replies have recipient
		this.broadcast = ( ( header & C.HEADERMASK_BROADCAST ) >> 3 ) == 1;
		switch ( packet[ 1 ] ) {
			case C.MSGTYPE_COMMAND:
			case C.MSGTYPE_INQUIRY:
			case C.MSGTYPE_ADDRESS_SET:
			case C.MSGTYPE_NETCHANGE:
				this.msgType = packet[ 1 ];
				this.socket = 0;
				break;
			default:
				this.socket = packet[ 1 ] & 0b00001111;
				this.msgType = packet[ 1 ] & 0b11110000;
		}
		this.data = packet.slice( 2, packet.length - 1 ); // might be empty, ignore terminator

		// if data is more than one byte, the first byte determines the dataType
		this.dataType = ( this.data.length < 2 ) ? 0 : this.data.splice( 0, 1 )[ 0 ];
	}

	// will lookup a description based on constant names
	_makeDescription() :string {
		// find message type
		let msgTypeString = ''
		let dataTypeString = ''
		let cmdTypeString = undefined;
		for (let key of Object.keys(C)) {
			let val = C[key];
			if (key.match(/MSGTYPE/) && val == this.msgType) msgTypeString = key;
			else if (key.match(/DATATYPE/) && val == this.dataType) dataTypeString = key;
			else if (this.data.length > 0 && val == this.data[0]) cmdTypeString = key;
		}
		return `(msg: ${msgTypeString}, type: ${dataTypeString}, command: ${cmdTypeString})`;
	}

	// public instance methods

	// these might be called from another file, so leave them public
	handleAck() {
		this.status = C.MSGTYPE_ACK;
		if ( this.onAck != undefined ) this.onAck();
	}

	handleError(err:string) {
		this.status = C.MSGTYPE_ERROR;
		if ( this.onError != undefined ) this.onError(err);
	}

	// some command completions include data
	handleComplete( data: number[] | undefined = undefined ) {
		this.status = C.MSGTYPE_COMPLETE;
		if ( this.dataParser != undefined && data != undefined ) {
			data = this.dataParser( data );
		}
		if ( this.onComplete != undefined ) {
			if ( data == undefined || data.length == 0 )
				this.onComplete();
			else
				this.onComplete( data );
		}
	}

	toString() : string {
		if (this.description == '') {
			this.description = this._makeDescription()
		}
		
		this.packetHexString = this._hexify(this.toPacket());
		return JSON.stringify(this);
	}

	toPacket(): number[] {
		let header = this._header();
		let qq = this.msgType | this.socket;
		let rr = this.dataType;
		if ( rr > 0 )
			return [ header, qq, rr, ...this.data, 0xff ];
		else
			return [ header, qq, ...this.data, 0xff ];
	}

	send( transport: ViscaTransport ) {
		transport.write( this );
	}

	// ---------------------
	// static constructors
	// ---------------------

	static fromPacket( packet: number[] ) {
		let v = new ViscaCommand( {} );
		v._parsePacket( packet );
		return v;
	}

	static raw( recipient: number, raw: number[] ) {
		let v = new ViscaCommand( { recipient } );
		v._parsePacket( [ v._header(), ...raw, 0xff ] );
		return v;
	}

	// commands for each message type
	static cmd( recipient = -1, dataType: number, data: number[] = [], description: string = '' ) {
		return new ViscaCommand( { msgType: C.MSGTYPE_COMMAND, dataType, recipient, data, description } );
	}
	static inquire( recipient = -1, dataType: number, data: number[], onComplete?: Function, dataParser?: (x:number[])=>any, description: string = '' ) {
		return new ViscaCommand( { msgType: C.MSGTYPE_INQUIRY, dataType, recipient, data, dataParser, onComplete, description } );
	}
	static cancel( recipient = -1, socket = 0 ) {
		return new ViscaCommand( { msgType: C.MSGTYPE_CANCEL | socket, recipient, description: `cancel command in buffer ${socket}` } );
	}
	static addressSet() {
		// recipient is not needed because it should always start at the first camera
		return new ViscaCommand( { msgType: C.MSGTYPE_ADDRESS_SET, data: [ 1 ] } );
	}


	// commands for each datatype
	static cmdInterfaceClearAll( recipient = -1 ) {
		return ViscaCommand.cmd( recipient, C.DATATYPE_INTERFACE, [ 0, 1 ], 'interface clear all' );
	}
	static cmdCamera( recipient = -1, data: number[] = [], description: string = '') {
		return ViscaCommand.cmd( recipient, C.DATATYPE_CAMERA, data, description );
	}
	static cmdOp( recipient = -1, data: number[] = [], description: string = '' ) {
		return ViscaCommand.cmd( recipient, C.DATATYPE_OPERATION, data, description );
	}

	// inquiry commands complete with data
	static inqCamera( recipient = -1, query: number[], onComplete?: Function, dataParser?: (x:number[])=>any, description: string = '' ) {
		return ViscaCommand.inquire( recipient, C.DATATYPE_CAMERA, query, onComplete, dataParser, description );
	}
	static inqOp( recipient = -1, query: number[], onComplete: Function, dataParser: (x:number[])=>any, description: string = '' ) {
		return ViscaCommand.inquire( recipient, C.DATATYPE_OPERATION, query, onComplete, dataParser, description );
	}


	// ----------------------- Setters -------------------------------------

	// POWER ===========================
	static cmdCameraPower( device: number, enable = false ) {
		let powerval = enable ? C.DATA_ONVAL : C.DATA_OFFVAL;
		let subcmd = [ C.CAM_POWER, powerval ];
		return ViscaCommand.cmdCamera( device, subcmd, `camera power ${enable ? 'on' : 'off'}`);
	}
	static cmdCameraPowerAutoOff( device: number, time = 0 ) {
		// time = minutes without command until standby
		// 0: disable
		// 0xffff: 65535 minutes
		let subcmd = [ C.CAM_SLEEP_TIME, ...utils.i2v( time ) ];
		return ViscaCommand.cmdCamera( device, subcmd, `camera power auto off after ${time} minutes` );
	}

	// PRESETS =========================
	// Store custom presets if the camera supports them
	// Prisual supports 0-255
	// PTZOptics can store presets 0-127
	// Sony has only 0-5
	static cmdCameraPresetReset( device: number, preset = 0 ) {
		let subcmd = [ C.CAM_MEMORY, C.DATA_MEMORY_RESET, preset ];
		return ViscaCommand.cmdCamera( device, subcmd, `camera preset ${preset} reset` );
	}
	static cmdCameraPresetSet( device: number, preset = 0 ) {
		let subcmd = [ C.CAM_MEMORY, C.DATA_MEMORY_SET, preset ];
		return ViscaCommand.cmdCamera( device, subcmd, `camera preset ${preset} set` );
	}
	static cmdCameraPresetRecall( device: number, preset = 0 ) {
		let subcmd = [ C.CAM_MEMORY, C.DATA_MEMORY_RECALL, preset ];
		return ViscaCommand.cmdCamera( device, subcmd, `camera preset ${preset} recall` );
	}

	// PAN/TILT ===========================
	// 8x 01 06 01 VV WW XX YY FF
	// VV = x(pan) speed  1-18
	// WW = y(tilt) speed 1-17
	// XX = x mode 01 (dec), 02 (inc), 03 (stop)
	// YY = y mode 01 (dec), 02 (inc), 03 (stop)
	// x increases rightward
	// y increases downward!!
	static cmdCameraPanTilt( device: number, xspeed: number, yspeed: number, xmode: number, ymode: number ) {
		let subcmd = [ C.OP_PAN_DRIVE, xspeed, yspeed, xmode, ymode ];
		return ViscaCommand.cmdOp( device, subcmd, 'camera pan/tilt' );
	}
	// x and y are signed 16 bit integers, 0x0000 is center
	// range is -2^15 - 2^15 (32768)
	// relative defaults to false
	static cmdCameraPanTiltDirect( device: number, xspeed: number, yspeed: number, x: number, y: number, relative = false ) {
		let xpos = utils.si2v( x );
		let ypos = utils.si2v( y );
		let absrel = relative ? C.OP_PAN_RELATIVE : C.OP_PAN_ABSOLUTE;
		let subcmd = [ absrel, xspeed, yspeed, ...xpos, ...ypos ];
		return ViscaCommand.cmdOp( device, subcmd, 'camera pan/tilt direct');
	}
	static cmdCameraPanTiltHome( device: number ) { return ViscaCommand.cmdOp( device, [ C.OP_PAN_HOME ], 'camera pan/tilt home' ) }
	static cmdCameraPanTiltReset( device: number ) { return ViscaCommand.cmdOp( device, [ C.OP_PAN_RESET ], 'camera pan/tilt reset' ) }
	
	// corner should be C.DATA_PANTILT_UR or C.DATA_PANTILT_BL
	static cmdCameraPanTiltLimitSet( device: number, corner: number, x: number, y: number ) {
		let xv = utils.si2v( x );
		let yv = utils.si2v( y );
		let subcmd = [ C.OP_PAN_LIMIT, C.DATA_RESET, corner, ...xv, ...yv ];
		return ViscaCommand.cmdOp( device, subcmd );
	}
	static cmdCameraPanTiltLimitClear( device: number, corner: number ) {
		let subcmd = [ C.OP_PAN_LIMIT, C.CMD_CAM_VAL_CLEAR, corner, 0x07, 0x0F, 0x0F, 0x0F, 0x07, 0x0F, 0x0F, 0x0F ];
		return ViscaCommand.cmdOp( device, subcmd );
	}

	// ZOOM ===============================
	/// offinout = 0x00, 0x02, 0x03
	/// speed = 0(low)..7(high) (-1 means default)
	static cmdCameraZoom( device: number, offinout = C.DATA_RESET, speed = -1 ) {
		let data = offinout;
		if ( speed > -1 && offinout != C.DATA_RESET ) data = ( data << 8 ) + ( speed & 0b111 )
		let subcmd = [ C.CAM_ZOOM, data ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraZoomStop( device: number ) {
		return ViscaCommand.cmdCameraZoom( device, C.DATA_RESET );
	}
	/// zoom in with speed = 0..7 (-1 means default)
	static cmdCameraZoomIn( device: number, speed = -1 ) {
		return ViscaCommand.cmdCameraZoom( device, C.DATA_MORE, speed );
	}
	/// zoom out with speed = 0..7 (-1 means default)
	static cmdCameraZoomOut( device: number, speed = -1 ) {
		return ViscaCommand.cmdCameraZoom( device, C.DATA_LESS, speed );
	}

	/// max zoom value is 0x4000 (16384) unless digital is enabled
	/// 0xpqrs -> 0x0p 0x0q 0x0r 0x0s
	static cmdCameraZoomDirect( device: number, zoomval: number ) {
		let subcmd = [ C.CAM_ZOOM_DIRECT, ...utils.i2v( zoomval ) ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// Digital Zoom enable/disable
	static cmdCameraDigitalZoom( device: number, enable = false ) {
		let data = enable ? C.DATA_ONVAL : C.DATA_OFFVAL;
		let subcmd = [ C.CAM_DZOOM, data ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// Focus controls

	/// stopfarnear = 0x00, 0x02, 0x03
	/// speed = 0(low)..7(high) -1 means default
	static cmdCameraFocus( device: number, stopfarnear = C.DATA_RESET, speed = -1 ) {
		let data = stopfarnear;
		if ( speed > -1 && stopfarnear != C.DATA_RESET ) data = ( data << 8 ) + ( speed & 0b111 )
		let subcmd = [ C.CAM_ZOOM, data ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraFocusStop( device: number ) {
		return ViscaCommand.cmdCameraFocus( device, C.DATA_RESET );
	}
	/// zoom in with speed = 0..7 (-1 means default)
	static cmdCameraFocusFar( device: number, speed = -1 ) {
		return ViscaCommand.cmdCameraFocus( device, C.DATA_MORE, speed );
	}
	/// zoom out with speed = 0..7 (-1 means default)
	static cmdCameraFocusNear( device: number, speed = -1 ) {
		return ViscaCommand.cmdCameraFocus( device, C.DATA_LESS, speed );
	}
	/// max focus value is 0xF000
	/// 0xpqrs -> 0x0p 0x0q 0x0r 0x0s
	static cmdCameraFocusDirect( device: number, focusval: number ) {
		let subcmd = [ C.CAM_FOCUS_DIRECT, ...utils.i2v( focusval ) ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraFocusAuto( device: number, enable = true ) {
		let data = enable ? C.DATA_ONVAL : C.DATA_OFFVAL;
		let subcmd = [ C.CAM_FOCUS_AUTO, data ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraFocusAutoToggle( device: number, data: number ) {
		let subcmd = [ C.CAM_FOCUS_AUTO, C.DATA_TOGGLEVAL ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraFocusTrigger( device: number, data: number ) {
		let subcmd = [ C.CAM_FOCUS_TRIGGER, C.CMD_CAM_FOCUS_TRIGGER_NOW ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraFocusInfinity( device: number, data: number ) {
		let subcmd = [ C.CAM_FOCUS_TRIGGER, C.CMD_CAM_FOCUS_TRIGGER_INF ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraFocusSetNearLimit( device: number, limit = 0xf000 ) {
		// limit must have low byte 0x00
		limit = limit & 0xff00;
		let subcmd = [ C.CAM_FOCUS_NEAR_LIMIT_POS, ...utils.i2v( limit ) ]
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraFocusAutoSensitivity( device: number, high = true ) {
		let data = high ? C.DATA_ONVAL : C.DATA_OFFVAL;
		let subcmd = [ C.CAM_FOCUS_SENSE_HIGH, data ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	/// mode = 0 (on motion), 1 (on interval), 2 (on zoom)
	static cmdCameraFocusAutoMode( device: number, mode = 0 ) {
		let subcmd = [ C.CAM_FOCUS_AF_MODE, mode ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraFocusAutoIntervalTime( device: number, movementTime = 0, intervalTime = 0 ) {
		let pqrs = ( movementTime << 8 ) + intervalTime;
		let subcmd = [ C.CAM_FOCUS_AF_INTERVAL, ...utils.i2v( pqrs ) ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraFocusIRCorrection( device: number, enable = false ) {
		let data = enable ? 0x00 : 0x01;
		let subcmd = [ C.CAM_FOCUS_IR_CORRECTION, data ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// combo zoom & focus
	static cmdCameraZoomFocus( device: number, zoomval = 0, focusval = 0 ) {
		let z = utils.i2v( zoomval );
		let f = utils.i2v( focusval );
		let subcmd = [ C.CAM_ZOOM_DIRECT, ...z, ...f ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}


	// OTHER IMAGE CONTROLS

	/// white balance
	/// mode = 0(auto),1(indoor),2(outdoor),3(trigger),5(manual) 
	static cmdCameraWBMode( device: number, mode = 0 ) {
		let subcmd = [ C.CAM_WB_MODE, mode ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraWBTrigger( device: number, data: number ) {
		let subcmd = [ C.CAM_WB_TRIGGER, 0x05 ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// VARIOUS EXPOSURE CONTROLS

	/// mode should be 'r' for RGain, 'b' for BGain. defaults to Gain
	/// resetupdown = 0, 2, 3
	/// value must be less than 0xff;
	static cmdCameraGain( device: number, mode = 'r', resetupdown = 0, directvalue = -1 ) {
		let subcmd;
		let gaintype;
		switch ( mode ) {
			case 'r':
				gaintype = C.CAM_RGAIN;
				break;
			case 'b':
				gaintype = C.CAM_BGAIN;
				break;
			default:
				gaintype = C.CAM_GAIN;
				break;
		}
		if ( directvalue > 0 ) {
			gaintype += 0x40;
			subcmd = [ gaintype, ...utils.i2v( directvalue ) ]
		} else {
			subcmd = [ gaintype, resetupdown ]
		}
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraGainUp( device: number ) { let mode = ''; return ViscaCommand.cmdCameraGain( device, mode, C.DATA_ONVAL ); }
	static cmdCameraGainDown( device: number ) { let mode = ''; return ViscaCommand.cmdCameraGain( device, mode, C.DATA_OFFVAL ); }
	static cmdCameraGainReset( device: number ) { let mode = ''; return ViscaCommand.cmdCameraGain( device, mode, C.DATA_RESET ); }
	static cmdCameraGainDirect( device: number, value: number ) { let mode = 'r'; return ViscaCommand.cmdCameraGain( device, mode, 0x00, value ); }
	static cmdCameraGainRUp( device: number ) { let mode = 'r'; return ViscaCommand.cmdCameraGain( device, mode, C.DATA_ONVAL ); }
	static cmdCameraGainRDown( device: number ) { let mode = 'r'; return ViscaCommand.cmdCameraGain( device, mode, C.DATA_OFFVAL ); }
	static cmdCameraGainRReset( device: number ) { let mode = 'r'; return ViscaCommand.cmdCameraGain( device, mode, 0x00 ); }
	static cmdCameraGainRDirect( device: number, value: number ) { let mode = 'r'; return ViscaCommand.cmdCameraGain( device, mode, 0x00, value ); }
	static cmdCameraGainBUp( device: number ) { let mode = 'b'; return ViscaCommand.cmdCameraGain( device, mode, C.DATA_ONVAL ); }
	static cmdCameraGainBDown( device: number ) { let mode = 'b'; return ViscaCommand.cmdCameraGain( device, mode, C.DATA_OFFVAL ); }
	static cmdCameraGainBReset( device: number ) { let mode = 'b'; return ViscaCommand.cmdCameraGain( device, mode, 0x00 ); }
	static cmdCameraGainBDirect( device: number, value: number ) { let mode = 'b'; return ViscaCommand.cmdCameraGain( device, mode, 0x00, value ); }
	/// gain value is from 4-F
	static cmdCameraGainLimit( device: number, value: number ) {
		let subcmd = [ C.CAM_GAIN_LIMIT, value ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// EXPOSURE =======================

	/// mode = 0, 3, A, B, D
	/// auto, manual, shutter priority, iris priority, bright
	static cmdCameraExposureMode( device: number, mode = 0x00 ) {
		let subcmd = [ C.CAM_EXPOSURE_MODE, mode ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraExposureCompensationEnable( device: number, enable = true ) {
		let subcmd = [ C.CAM_EXP_COMP_ENABLE, enable ? C.DATA_ONVAL : C.DATA_OFFVAL ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraExposureCompensationAdjust( device: number, resetupdown: number) {
		let subcmd = [ C.CAM_EXP_COMP, resetupdown ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraExposureCompensationUp( device: number ) {
		return ViscaCommand.cmdCameraExposureCompensationAdjust( device, C.DATA_MORE );
	}
	static cmdCameraExposureCompensationDown( device: number ) {
		return ViscaCommand.cmdCameraExposureCompensationAdjust( device, C.DATA_LESS );
	}
	static cmdCameraExposureCompensationReset( device: number ) {
		return ViscaCommand.cmdCameraExposureCompensationAdjust( device, C.DATA_RESET );
	}
	static cmdCameraExposureCompensationDirect( device: number, directval = 0 ) {
		let subcmd = [ C.CAM_EXP_COMP_DIRECT, ...utils.i2v( directval ) ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// BACKLIGHT =======================================
	static cmdCameraBacklightCompensation( device: number, enable = true ) {
		let subcmd = [ C.CAM_BACKLIGHT, enable ? 0x02 : 0x03 ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// SHUTTER ========================================

	/// resetupdown = 0, 2, 3
	static cmdCameraShutter( device: number, resetupdown:number, directvalue = -1 ) {
		let subcmd = [ C.CAM_SHUTTER, resetupdown ];
		if ( directvalue > -1 ) {
			subcmd = [ C.CAM_SHUTTER_DIRECT, ...utils.i2v( directvalue ) ];
		}
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraShutterUp( device: number ) { return ViscaCommand.cmdCameraShutter( device, C.DATA_MORE ) }
	static cmdCameraShutterDown( device: number ) { return ViscaCommand.cmdCameraShutter( device, C.DATA_LESS ) }
	static cmdCameraShutterReset( device: number ) { return ViscaCommand.cmdCameraShutter( device, C.DATA_RESET ) }
	static cmdCameraShutterDirect( device: number, value = 0 ) { return ViscaCommand.cmdCameraShutter( device, C.DATA_RESET, value ) }
	static cmdCameraShutterSlow( device: number, auto = true ) {
		let subcmd = [ C.CAM_SHUTTER_SLOW_AUTO, auto ? C.DATA_ONVAL : C.DATA_OFFVAL ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	/// IRIS ======================================
	/// resetupdown = 0, 2, 3
	static cmdCameraIris( device: number, resetupdown:number, directvalue = -1 ) {
		let subcmd = [ C.CAM_IRIS, resetupdown ];
		if ( directvalue > -1 ) {
			subcmd = [ C.CAM_IRIS_DIRECT, ...utils.i2v( directvalue ) ];
		}
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraIrisUp( device: number ) { return ViscaCommand.cmdCameraIris( device, C.DATA_MORE ) }
	static cmdCameraIrisDown( device: number ) { return ViscaCommand.cmdCameraIris( device, C.DATA_LESS ) }
	static cmdCameraIrisReset( device: number ) { return ViscaCommand.cmdCameraIris( device, C.DATA_RESET ) }
	static cmdCameraIrisDirect( device: number, value = 0 ) { return ViscaCommand.cmdCameraIris( device, C.DATA_RESET, value ) }
	// APERTURE =====================================
	/// resetupdown = 0, 2, 3
	static cmdCameraAperture( device: number, resetupdown:number, directvalue = -1 ) {
		let subcmd = [ C.CAM_APERTURE, resetupdown ];
		if ( directvalue > -1 ) {
			subcmd = [ C.CAM_APERTURE_DIRECT, ...utils.i2v( directvalue ) ];
		}
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraApertureUp( device: number ) { return ViscaCommand.cmdCameraAperture( device, C.DATA_MORE ) }
	static cmdCameraApertureDown( device: number ) { return ViscaCommand.cmdCameraAperture( device, C.DATA_LESS ) }
	static cmdCameraApertureReset( device: number ) { return ViscaCommand.cmdCameraAperture( device, C.DATA_RESET ) }
	static cmdCameraApertureDirect( device: number, value = 0 ) { return ViscaCommand.cmdCameraAperture( device, C.DATA_RESET, value ) }


	// QUALITY ==================================
	static cmdCameraHighResMode( device: number, enable = true ) {
		let subcmd = [ C.CAM_HIRES_ENABLE, enable ? C.DATA_ONVAL : C.DATA_OFFVAL ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraHighSensitivityMode( device: number, enable = true ) {
		let subcmd = [ C.CAM_HIGH_SENSITIVITY, enable ? C.DATA_ONVAL : C.DATA_OFFVAL ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	/// val = 0..5
	static cmdCameraNoiseReduction( device: number, val: number ) {
		let subcmd = [ C.CAM_NOISE_REDUCTION, val ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	/// val = 0..4
	static cmdCameraGamma( device: number, val: number ) {
		let subcmd = [ C.CAM_GAMMA, val ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// EFFECTS ========================================
	/// effect types are enumerated in the constants file
	static cmdCameraEffect( device: number, effectType: number ) {
		return ViscaCommand.cmdCamera( device, [ C.CAM_EFFECT, effectType ] );
	}
	static cmdCameraEffectDigital( device: number, effectType: number ) {
		return ViscaCommand.cmdCamera( device, [ C.CAM_EFFECT_DIGITAL, effectType ] );
	}
	static cmdCameraEffectDigitalIntensity( device: number, level: number ) {
		return ViscaCommand.cmdCamera( device, [ C.CAM_EFFECT_LEVEL, level ] );
	}

	// basic effects
	static cmdCameraEffectOff( device: number ) {
		return ViscaCommand.cmdCameraEffect( device, C.DATA_EFFECT_OFF );
	}
	static cmdCameraEffectPastel( device: number ) {
		return ViscaCommand.cmdCameraEffect( device, C.DATA_EFFECT_PASTEL );
	}
	static cmdCameraEffectNegative( device: number ) {
		return ViscaCommand.cmdCameraEffect( device, C.DATA_EFFECT_NEGATIVE );
	}
	static cmdCameraEffectSepia( device: number ) {
		return ViscaCommand.cmdCameraEffect( device, C.DATA_EFFECT_SEPIA );
	}
	static cmdCameraEffectBW( device: number ) {
		return ViscaCommand.cmdCameraEffect( device, C.DATA_EFFECT_BW );
	}
	static cmdCameraEffectSolar( device: number ) {
		return ViscaCommand.cmdCameraEffect( device, C.DATA_EFFECT_SOLAR );
	}
	static cmdCameraEffectMosaic( device: number ) {
		return ViscaCommand.cmdCameraEffect( device, C.DATA_EFFECT_MOSAIC );
	}
	static cmdCameraEffectSlim( device: number ) {
		return ViscaCommand.cmdCameraEffect( device, C.DATA_EFFECT_SLIM );
	}
	static cmdCameraEffectStretch( device: number ) {
		return ViscaCommand.cmdCameraEffect( device, C.DATA_EFFECT_STRETCH );
	}

	// digital effects
	static cmdCameraEffectDigitalOff( device: number ) {
		return ViscaCommand.cmdCameraEffectDigital( device, C.DATA_EFFECT_OFF );
	}
	static cmdCameraEffectDigitalStill( device: number ) {
		return ViscaCommand.cmdCameraEffectDigital( device, C.DATA_EFFECT_STILL );
	}
	static cmdCameraEffectDigitalFlash( device: number ) {
		return ViscaCommand.cmdCameraEffectDigital( device, C.DATA_EFFECT_FLASH );
	}
	static cmdCameraEffectDigitalLumi( device: number ) {
		return ViscaCommand.cmdCameraEffectDigital( device, C.DATA_EFFECT_LUMI );
	}
	static cmdCameraEffectDigitalTrail( device: number ) {
		return ViscaCommand.cmdCameraEffectDigital( device, C.DATA_EFFECT_TRAIL );
	}


	// FREEZE ====================================
	static cmdCameraFreeze( device: number, enable = true ) {
		let mode = enable ? C.DATA_ONVAL : C.DATA_OFFVAL;
		let subcmd = [ C.CAM_FREEZE, mode ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// ICR =======================================
	static cmdCameraICR( device: number, enable = true ) {
		let mode = enable ? C.DATA_ONVAL : C.DATA_OFFVAL;
		let subcmd = [ C.CAM_ICR, mode ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraICRAuto( device: number, enable = true ) {
		let mode = enable ? C.DATA_ONVAL : C.DATA_OFFVAL;
		let subcmd = [ C.CAM_AUTO_ICR, mode ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	static cmdCameraICRAutoThreshold( device: number, val = 0 ) {
		let subcmd = [ C.CAM_AUTO_ICR_THRESHOLD, ...utils.i2v( val ) ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// ID write
	static cmdCameraIDWrite( device: number, data: number ) {
		let subcmd = [ C.CAM_ID_WRITE, ...utils.i2v( data ) ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// Chroma Suppress
	// value = 0(off), 1-3
	static cmdCameraChromaSuppress( device: number, value: number ) {
		let subcmd = [ C.CAM_CHROMA_SUPPRESS, value ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	// value = 0h - Eh
	static cmdCameraColorGain( device: number, value: number ) {
		let subcmd = [ C.CAM_COLOR_GAIN, value ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}
	// value = 0h - Eh
	static cmdCameraColorHue( device: number, value: number ) {
		let subcmd = [ C.CAM_COLOR_HUE, value ];
		return ViscaCommand.cmdCamera( device, subcmd );
	}

	// TODO:
	// CAM_WIDE_D
	// VIDEO_SYSTEM_SET
	// IR Receive
	// IR Receive Return
	// Information Display

	// ---------------- Inquiries ---------------------------
	// [onComplete] should take the datatype returned by the parser
	static inqCameraPower = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_POWER ], onComplete, Parsers.IsOnParser.parse);
	static inqCameraICRMode = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_ICR ], onComplete, Parsers.IsOnParser.parse);
	static inqCameraICRAutoMode = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_AUTO_ICR ], onComplete, Parsers.IsOnParser.parse);
	static inqCameraICRThreshold = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_AUTO_ICR_THRESHOLD ], onComplete, Parsers.v2iParser.parse);
	static inqCameraGainLimit = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_GAIN_LIMIT ], onComplete, Parsers.ByteValParser.parse);
	static inqCameraGain = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_GAIN_DIRECT ], onComplete, Parsers.v2iParser.parse);
	static inqCameraGainR = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_RGAIN_DIRECT ], onComplete, Parsers.v2iParser.parse);
	static inqCameraGainB = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_BGAIN_DIRECT ], onComplete, Parsers.v2iParser.parse);

	static inqCameraDZoomMode = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_DZOOM ], onComplete, Parsers.IsOnParser.parse);
	static inqCameraZoomPos = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_ZOOM_DIRECT ], onComplete, Parsers.v2iParser.parse);

	static inqCameraFocusAutoStatus = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_FOCUS_AUTO ], onComplete, Parsers.IsOnParser.parse);
	static inqCameraFocusAutoMode = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_FOCUS_AF_MODE ], onComplete, Parsers.ByteValParser.parse );
	static inqCameraFocusIRCorrection = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_FOCUS_IR_CORRECTION ], onComplete,Parsers.ByteValParser.parse );
	static inqCameraFocusPos = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_FOCUS_DIRECT ], onComplete, Parsers.v2iParser.parse);
	static inqCameraFocusNearLimit = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_FOCUS_NEAR_LIMIT_POS ], onComplete, Parsers.v2iParser.parse);
	static inqCameraFocusAutoIntervalTime = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_FOCUS_AF_INTERVAL ], onComplete, Parsers.AFIntervalParser.parse);
	static inqCameraFocusSensitivity = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_FOCUS_SENSE_HIGH ], onComplete, Parsers.ByteValParser.parse );

	static inqCameraWBMode = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_WB_MODE ], onComplete ,Parsers.ByteValParser.parse);
	static inqCameraExposureMode = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_EXPOSURE_MODE ], onComplete ,Parsers.ByteValParser.parse);
	static inqCameraShutterSlowMode = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_SHUTTER_SLOW_AUTO ], onComplete, Parsers.IsOnParser.parse);
	static inqCameraShutterPos = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_SHUTTER_DIRECT ], onComplete, Parsers.v2iParser.parse);
	static inqCameraIris = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_IRIS_DIRECT ], onComplete, Parsers.v2iParser.parse);
	static inqCameraBrightness = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_BRIGHT_DIRECT ], onComplete, Parsers.v2iParser.parse);
	static inqCameraExposureCompStatus = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_EXP_COMP_ENABLE ], onComplete, Parsers.IsOnParser.parse);
	static inqCameraExposureCompPosition = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_EXP_COMP_DIRECT ], onComplete, Parsers.v2iParser.parse);
	static inqCameraBacklightStatus = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_BACKLIGHT ], onComplete, Parsers.IsOnParser.parse);

	static inqCameraWideDMode = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_WIDE_D ], onComplete, Parsers.ByteValParser.parse );
	static inqCameraWideDParams = ( recipient = -1, onComplete: (x:CamWideDParams)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_WIDE_D_SET ], onComplete, Parsers.CamWideDParamsParser.parse);

	static inqCameraAperture = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_APERTURE_DIRECT ], onComplete, Parsers.v2iParser.parse);
	static inqCameraHighResStatus = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_HIRES_ENABLE ], onComplete, Parsers.IsOnParser.parse);
	static inqCameraNoiseReductionStatus = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_NOISE_REDUCTION ], onComplete ,Parsers.ByteValParser.parse);
	static inqCameraHighSensitivityStatus = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_HIGH_SENSITIVITY ], onComplete, Parsers.IsOnParser.parse);
	static inqCameraFreezeStatus = ( recipient = -1, onComplete: (x:boolean)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_FREEZE ], onComplete, Parsers.IsOnParser.parse);
	static inqCameraEffect = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_EFFECT ], onComplete ,Parsers.ByteValParser.parse);
	static inqCameraEffectDigital = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_EFFECT_DIGITAL ], onComplete ,Parsers.ByteValParser.parse);
	static inqCameraEffectDigitalLevel = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_EFFECT_LEVEL ], onComplete ,Parsers.ByteValParser.parse);

	static inqCameraID = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_ID_WRITE ], onComplete, Parsers.v2iParser.parse);
	static inqCameraChromaSuppressStatus = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_CHROMA_SUPPRESS ], onComplete ,Parsers.ByteValParser.parse);
	static inqCameraColorGain = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_COLOR_GAIN ], onComplete, Parsers.v2iParser.parse);
	static inqCameraColorHue = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqCamera( recipient, [ C.CAM_COLOR_HUE ], onComplete, Parsers.v2iParser.parse);

	// these use op commands
	static inqVideoFormatNow = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqOp( recipient, [ C.OP_VIDEO_FORMAT_I_NOW ], onComplete, Parsers.ByteValParser.parse);
	static inqVideoFormatNext = ( recipient = -1, onComplete: (x:number)=>void ) => ViscaCommand.inqOp( recipient, [ C.OP_VIDEO_FORMAT_I_NEXT ], onComplete, Parsers.ByteValParser.parse);

	static inqCameraPanTiltSpeed = ( recipient = -1, onComplete: (x:PTSpeed)=>void ) => ViscaCommand.inqOp( recipient, [ C.OP_PAN_MAX_SPEED ], onComplete, Parsers.PTMaxSpeedParser.parse);
	static inqCameraPanTiltPos = ( recipient = -1, onComplete: (x:PTPos)=>void ) => ViscaCommand.inqOp( recipient, [ C.OP_PAN_POS ], onComplete, Parsers.PTPosParser.parse);
	static inqCameraPanTiltStatus = ( recipient = -1, onComplete: (x:PTStatus)=>void ) => ViscaCommand.inqOp( recipient, [ C.OP_PAN_STATUS ], onComplete, Parsers.PTStatusParser.parse);

	// block inquiry commands
	static inqCameraLens = ( recipient = -1, onComplete: (x:CamLensData)=>void ) => { let c = ViscaCommand.raw( recipient, C.CAM_LENS_INQUIRY ); c.dataParser = Parsers.CamLensDataParser.parse; c.onComplete = onComplete; return c; }
	static inqCameraImage = ( recipient = -1, onComplete: (x:CamImageData)=>void ) => { let c = ViscaCommand.raw( recipient, C.CAM_IMAGE_INQUIRY ); c.dataParser = Parsers.CamImageDataParser.parse; c.onComplete = onComplete; return c; }
}
