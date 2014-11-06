'use strict';

// CognicityReportsPowertrack.js - cognicity-reports-powertrack modules

/* jshint node:true */
/* jshint unused:vars */ // We want to keep function parameters on callbacks like the originals
/* jshint curly:false */ // Don't require curly brackets around one-line statements

/** Gnip PowerTrack interface module */
var Gnip = require('gnip');

/**
 * A CognicityReportsPowertrack object:
 * - connects to a powertrack stream
 * - monitors tweets based on configuration
 * - sends messages to users via twitter
 * - stores data from tweets in database
 * @constructor
 * @this {CognicityReportsPowertrack} 
 * @param {Object} config Configuration object
 * @param {Object} twit Configured instance of twitter object from ntwitter module
 * @param {Object} pg Configured instance of pg object from pg module
 * @param {Object} logger Configured instance of logger object from Winston module 
 */
var CognicityReportsPowertrack = function(
	config,
	twit,
	pg,
	logger
		){
	
	this.config = config;
	this.twit = twit;
	this.pg = pg;
	this.logger = logger;
};

CognicityReportsPowertrack.prototype = {
	/** 
	 * Configuration object
	 * @type {Object} 
	 */
	config: null,
	/** 
	 * Configured instance of twitter object from ntwitter module
	 * @type {Object} 
	 */
	twit: null,
	/** 
	 * Configured instance of pg object from pg module
	 * @type {Object} 
	 */
	pg: null,
	/** 
	 * Configured instance of logger object from Winston module
	 * @type {Object} 
	 */
	logger: null,
		
	/**
	 * Resolve message code from config.twitter.
	 * Will fall back to trying to resolve message using default language set in configuration.
	 * @param {string} code Code to lookup in config.twitter 
	 * @param {string} lang Language to lookup in config.twitter[code]
	 * @returns {string} Message code, or null if not resolved.
	 */
	getMessage: function(code, lang) {
		var self = this;
		
		if (self.config.twitter[code]) {
			if (self.config.twitter[code][lang]) return self.config.twitter[code][lang];
			if (self.config.twitter[code][self.config.twitter.defaultLanguage]) return self.config.twitter[code][self.config.twitter.defaultLanguage];
		}
		
		self.logger.warn( "getMessage: Code could not be resolved for '" + code + "' and lang '" + lang +"'" );
		return null;
	},
	
	/**
	 * DB query success callback
	 * @callback dbQuerySuccess
	 * @param {object} result The 'pg' module result object on a successful query
	 */
	
	/**
	 * Execute the SQL against the database connection. Run the success callback on success if supplied.
	 * @param {Object} config The pg config object for a parameterized query, e.g. {text:"select * from foo where a=$1", values:['bar']} 
	 * @param {dbQuerySuccess} success Callback function to execute on success.
	 */
	dbQuery: function(config, success){
		var self = this;

		self.logger.debug( "dbQuery: executing query: " + JSON.stringify(config) );
		self.pg.connect(self.config.pg.conString, function(err, client, done){
			if (err){
				self.logger.error("dbQuery: " + JSON.stringify(config) + ", " + err);
				done();
				return;
			}	
			client.query(config, function(err, result){
				if (err){
					self.logger.error("dbQuery: " + JSON.stringify(config) + ", " + err);
					done();
					return;
				}
				done();
				self.logger.debug( "dbQuery: success: " + JSON.stringify(config) );
				if (success) {
					try {
						success(result);
					} catch(error) {
						self.logger.error("dbQuery: Error in success callback: " + error.message + ", " + error.stack);
					}
				}
			});
		});
	},
	
	/**
	 * Only execute the success callback if the user is not currently in the all users table.
	 * @param {string} user The twitter screen name to check if exists
	 * @param {dbQuerySuccess} callback Callback to execute if the user doesn't exist
	 */
	ifNewUser: function(user, success){
		var self = this;

		self.dbQuery(
			{
				text: "SELECT user_hash FROM " + self.config.pg.table_all_users + " WHERE user_hash = md5($1);",
				values: [ user ]
			},
			function(result) {
				if (result && result.rows && result.rows.length === 0) {
					success(result);
				} else {
					self.logger.debug("Not performing callback as user already exists");
				}
			}	
		);
	},
	
	/**
	 * Send @reply Twitter message
	 * @param {string} user The twitter screen name to send to
	 * @param {string} message The tweet text to send
	 * @param {function} callback Callback function called on success
	 */
	sendReplyTweet: function(user, message, callback){
		var self = this;

		self.ifNewUser( user, function(result) {
			if (self.config.twitter.send_enabled === true){
				self.twit.updateStatus('@'+user+' '+message, function(err, data){
					if (err) {
						self.logger.error('Tweeting failed: ' + err);
					} else {
						if (callback) callback();
					}
				});	
			} else { // for testing
				self.logger.info('sendReplyTweet is in test mode - no message will be sent. Callback will still run.');
				self.logger.info('@'+user+' '+message);
				if (callback) callback();
			}
		});
	},
		
	/**
	 * Insert a confirmed report - i.e. has geo coordinates and is addressed.
	 * Store both the tweet information and the user hash.
	 * @param tweetActivity Gnip PowerTrack tweet activity object
	 */
	insertConfirmed: function(tweetActivity){
		var self = this;

		//insertUser with count -> upsert	
		self.dbQuery(
			{
				text : "INSERT INTO " + self.config.pg.table_tweets + " " +
					"(created_at, text, hashtags, urls, user_mentions, lang, the_geom) " +
					"VALUES (" +
					"to_timestamp($1::text, 'Dy Mon DD YYYY HH24:MI:SS +ZZZZ'), " +
					"$2, " +
					"$3, " + 
					"$4, " + 
					"$5, " + 
					"$6, " + 
					"ST_GeomFromText('POINT($7)',4326)" +
					");",
				values : [
				    new Date(Date.parse(tweetActivity.postedTime)).toLocaleString(),
				    tweetActivity.body,
				    JSON.stringify(tweetActivity.twitter_entities.hashtags),
				    JSON.stringify(tweetActivity.twitter_entities.urls),
				    JSON.stringify(tweetActivity.twitter_entities.user_mentions),
				    tweetActivity.twitter_lang,
				    tweetActivity.geo.coordinates[0] + " " + tweetActivity.geo.coordinates[1]
				]
			},
			function(result) {
				self.logger.info('Logged confirmed tweet report');
				self.dbQuery( 
					{
						text : "SELECT upsert_tweet_users(md5($1));",
						values : [
						    tweetActivity.actor.preferredUsername
						]
					},
					function(result) {
						self.logger.info('Logged confirmed tweet user');
					}
				);
			}
		);
	},
	
	/**
	 * Insert an invitee - i.e. a user we've invited to participate.
	 * @param tweetActivity Gnip PowerTrack tweet activity object
	 */
	insertInvitee: function(tweetActivity){
		var self = this;

		self.dbQuery( 
			{
				text : "INSERT INTO " + self.config.pg.table_invitees + " (user_hash) VALUES (md5($1));",
				values : [ tweetActivity.actor.preferredUsername ]
			},
			function(result) {
				self.logger.info('Logged new invitee');
			}
		);
	},
		
	/**
	 * Insert an unconfirmed report - i.e. has geo coordinates but is not addressed.
	 * @param tweetActivity Gnip PowerTrack tweet activity object
	 */
	insertUnConfirmed: function(tweetActivity){
		var self = this;

		self.dbQuery(
			{
				text : "INSERT INTO " + self.config.pg.table_unconfirmed + " " +
					"(created_at, the_geom) " +
					"VALUES ( " +
					"to_timestamp($1::text, 'Dy Mon DD YYYY HH24:MI:SS +ZZZZ'), " +
					"ST_GeomFromText('POINT($2)',4326)" +
					");",
				values : [
				    new Date(Date.parse(tweetActivity.postedTime)).toLocaleString(),
				    tweetActivity.geo.coordinates[0] + " " + tweetActivity.geo.coordinates[1]
				]
			},
			function(result) {
				self.logger.info('Logged unconfirmed tweet report');
			}
		);
	},
		
	/**
	 * Insert a non-spatial tweet report - i.e. we got an addressed tweet without geo coordinates.
	 * @param tweetActivity Gnip PowerTrack tweet activity object
	 */
	insertNonSpatial: function(tweetActivity){
		var self = this;

		self.dbQuery(
			{
				text : "INSERT INTO " + self.config.pg.table_nonspatial_tweet_reports + " " +
					"(created_at, text, hashtags, urls, user_mentions, lang) " +
					"VALUES (" +
					"to_timestamp($1::text, 'Dy Mon DD YYYY H24:MI:SS +ZZZZ'), " +
					"$2, " + 
					"$3, " + 
					"$4, " + 
					"$5, " + 
					"$6" +
					");",
				values : [
					new Date(Date.parse(tweetActivity.postedTime)).toLocaleString(),
					tweetActivity.body,
					JSON.stringify(tweetActivity.twitter_entities.hashtags),
					JSON.stringify(tweetActivity.twitter_entities.urls),
					JSON.stringify(tweetActivity.twitter_entities.user_mentions),
					tweetActivity.twitter_lang
				]
			},
			
			function(result) {
				self.logger.info('Inserted non-spatial tweet');
			}
		);
		
		self.ifNewUser( tweetActivity.actor.preferredUsername, function(result) {
			self.dbQuery( 
				{
					text : "INSERT INTO " + self.config.pg.table_nonspatial_users + " (user_hash) VALUES (md5($1));",
					values : [ tweetActivity.actor.preferredUsername ]
				},
				function(result) {
					self.logger.info("Inserted non-spatial user");
				}
			);
		});
	},
		
	/**
	 * Main stream tweet filtering logic.
	 * Filter the incoming tweet and decide what action needs to be taken:
	 * confirmed report, ask for geo, ask user to participate, or nothing
	 * @param tweetActivity The tweet activity from Gnip
	 */
	filter: function(tweetActivity){
		var self = this;

		self.logger.verbose( 'filter: Received tweetActivity: screen_name="' + tweetActivity.actor.preferredUsername + '", text="' + tweetActivity.body.replace("\n", "") + '", coordinates="' + (tweetActivity.geo && tweetActivity.geo.coordinates ? tweetActivity.geo.coordinates[0]+", "+tweetActivity.geo.coordinates[1] : 'N/A') + '"' );
		
		// Everything incoming has a keyword already, so we now try and categorize it using the Gnip tags
		var hasGeo = (tweetActivity.geo && tweetActivity.geo.coordinates);
		var geoInBoundingBox = false;
		var addressed = false;
		var locationMatch = false;
		
		tweetActivity.gnip.matching_rules.forEach( function(rule){
			if (rule.tag) {
				if (rule.tag.indexOf("geo")===0) geoInBoundingBox = true;
				if (rule.tag.indexOf("addressed")===0) addressed = true;
				if (rule.tag.indexOf("location")===0) locationMatch = true;
			}
		});
		var tweetCategorizations = (geoInBoundingBox?'+':'-') + "BOUNDINGBOX " +
			(hasGeo?'+':'-') + "GEO " +
			(addressed?'+':'-') + "ADDRESSED " + 
			(locationMatch?'+':'-') + "LOCATION";
		
		self.logger.verbose("filter: Categorized tweetActivity via Gnip tags as " + tweetCategorizations);
		
		// Perform the actions for the categorization of the tween
		if ( geoInBoundingBox && addressed ) {
			self.logger.verbose( 'filter: +BOUNDINGBOX +ADDRESSED = confirmed report' );
			
			self.insertConfirmed(tweetActivity); //user + geo = confirmed report!	
			
		} else if ( !geoInBoundingBox && !hasGeo && addressed && locationMatch ) {
			self.logger.verbose( 'filter: -BOUNDINGBOX -GEO +ADDRESSED +LOCATION = ask user for geo' );
			
			self.insertNonSpatial(tweetActivity); //User sent us a message but no geo, log as such
			self.sendReplyTweet( tweetActivity.actor.preferredUsername, self.getMessage('thanks_text', tweetActivity.twitter_lang) ); //send geo reminder
			
		} else if ( geoInBoundingBox && !addressed ) {
			self.logger.verbose( 'filter: +BOUNDINGBOX -ADDRESSED = unconfirmed report, ask user to participate' );
	
			self.insertUnConfirmed(tweetActivity); //insert unconfirmed report, then invite the user to participate
			self.sendReplyTweet(tweetActivity.actor.preferredUsername, self.getMessage('invite_text', tweetActivity.twitter_lang), function(){
				self.insertInvitee(tweetActivity);
			});	
			
		} else if ( !geoInBoundingBox && !hasGeo && !addressed && locationMatch ) {
			self.logger.verbose( 'filter: -BOUNDINGBOX -GEO -ADDRESSED +LOCATION = ask user to participate' );
			
			self.sendReplyTweet(tweetActivity.actor.preferredUsername, self.getMessage('invite_text', tweetActivity.twitter_lang), function(){
				self.insertInvitee(tweetActivity);
			});
			
		} else {
			self.logger.warn( 'filter: Tweet did not match category actions: ' + tweetCategorizations );
		}
	},
	
	/**
	 * Connect the Gnip stream.
	 * Establish the network connection, push rules to Gnip.
	 * Setup error handlers and timeout handler.
	 * Handle events from the stream on incoming data.
	 */
	connectStream: function(){
		var self = this;

		// Gnip stream
		var stream;
		// Timeout reconnection delay, used for exponential backoff
		var streamReconnectTimeout = 1;
		// Connect Gnip stream and setup event handlers
		var reconnectTimeoutHandle;
	
		// TODO Get backfill data on reconnect?
		// TODO Get replay data on reconnect?
		
		// Attempt to reconnect the socket. 
		// If we fail, wait an increasing amount of time before we try again.
		function reconnectSocket() {
			// Try and destroy the existing socket, if it exists
			self.logger.warn( 'connectStream: Connection lost, destroying socket' );
			if ( stream._req ) stream._req.destroy();
			// Attempt to reconnect
			self.logger.info( 'connectStream: Attempting to reconnect stream' );
			stream.start();
			streamReconnectTimeout *= 2;
			// TODO Set max timeout and notify if we hit it?
		}
	
		// TODO We get called twice for disconnect, once from error once from end
		// Is this normal? Can we only use one event? Or is it possible to get only
		// one of those handlers called under some error situations.
		
		// Attempt to reconnect the Gnip stream.
		// This function handles us getting called multiple times from different error handlers.
		function reconnectStream() {				
			if (reconnectTimeoutHandle) clearTimeout(reconnectTimeoutHandle);
			self.logger.info( 'connectStream: queing reconnect for ' + streamReconnectTimeout );
			reconnectTimeoutHandle = setTimeout( reconnectSocket, streamReconnectTimeout*1000 );
		}
		
		// Configure a Gnip stream with connection details
		stream = new Gnip.Stream({
		    url : self.config.gnip.steamUrl,
		    user : self.config.gnip.username,
		    password : self.config.gnip.password
		});
		
		// When stream is connected, setup the stream timeout handler
		stream.on('ready', function() {
			self.logger.info('connectStream: Stream ready!');
		    streamReconnectTimeout = 1;
			// Augment Gnip.Stream._req (Socket) object with a timeout handler.
			// We are accessing a private member here so updates to gnip could break this,
		    // but gnip module does not expose the socket or methods to handle timeout.
			stream._req.setTimeout( self.config.gnip.streamTimeout, function() {
				reconnectStream();
			});
		});
	
		// When we receive a tweetActivity from the Gnip stream this event handler will be called
		stream.on('tweet', function(tweetActivity) {
			self.logger.debug("connectStream: stream.on('tweet'): tweet = " + JSON.stringify(tweetActivity));
			
			// Catch errors here, otherwise error in filter method is caught as stream error
			try {
				self.filter(tweetActivity);
			} catch (err) {
				self.logger.error("connectStream: stream.on('tweet'): Error on handler:" + err.message + ", " + err.stack);
			}
		});
		
		// Handle an error from the stream
		stream.on('error', function(err) {
			self.logger.error("connectStream: Error connecting stream:" + err);
			reconnectStream();
		});
		
		// TODO Do we need to catch the 'end' event?
		// Handle a socket 'end' event from the stream
		stream.on('end', function() {
			self.logger.error("connectStream: Stream ended");
			reconnectStream();
		});
	
		// Construct a Gnip rules connection
		var rules = new Gnip.Rules({
		    url : self.config.gnip.rulesUrl,
		    user : self.config.gnip.username,
		    password : self.config.gnip.password
		});
		
		// Create rules programatically from config
		// Use key of rule entry as the tag, and value as the rule string
		var newRules = [];
		for (var tag in self.config.gnip.rules) {
			if ( self.config.gnip.rules.hasOwnProperty(tag) ) {
				newRules.push({
					tag: tag,
					value: self.config.gnip.rules[tag]
				});
			}
		}
		self.logger.debug('connectStream: Rules = ' + JSON.stringify(newRules));
		
		// Push the parsed rules to Gnip
		self.logger.info('connectStream: Updating rules...');
		rules.update(newRules, function(err) {
		    if (err) throw err;
			self.logger.info('connectStream: Connecting stream...');
			// If we pushed the rules successfully, now try and connect the stream
			stream.start();
		});
		
	}		
};

// Export our object constructor method from the module
module.exports = CognicityReportsPowertrack;