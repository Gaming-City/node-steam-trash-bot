var fs = require('fs');
var crypto = require('crypto');

var steam = require('steam');
var SteamTrade = require('steam-trade');
var winston = require('winston');
var request = require('request');
var cheerio = require('cheerio');
var uuid = require('node-uuid');
var _ = require('underscore');
var spawn = require('child_process');

var secrets = require('./secrets.js').secrets;

var serversFile = 'servers';
var sentryFile = 'sentry';
var cookieFile = 'cookies';
var webSessionId = null;
var cookies = null;
var canTrade = false;
var paused = false;
var respondingToTradeRequests = false; // True when using CasperJS to accept web-based trades
var autoFriendRemoveTimeout = 6*60*60*1000; // 6 hours
var acceptTradeOfferTimeout = 5*60*1000; // 5 mintues
var maxTradeHistoryPage = 300;
var maxTradeRequestMessages = 50;

var sendInstructions1 = "If you want to give me something, offer it for trade, check ready, and I'll check ready soon after.";
var sendInstructions2 = "Click Make Trade when you're sure you want to send me your items.";
var takeInstructions1 = "If you want me to send you something from my inventory, go to my inventory:";
var takeInstructions2 = 'http://steamcommunity.com/id/' + secrets.profileId + '/inventory/ ,';
var takeInstructions3 = 'then right click on what you want and select "Copy Link Address", then paste that into this trade';
var takeInstructions4 = 'chat window and I\'ll add the item. Check ready then click Make Trade when you\'re ready.';
var tradeCompleteMessage = "Trade complete! Please remember to remove me from your friends list if you don't want to make any more trades so that other \
people can trade with me. If you want to make trades later you can always re-add me.";
var wrongLinkMessage = 'It looks like you selected "Copy Page URL", you need to select "Copy Link Address"';
var badLinkMessage = 'I don\'t recognise that link.';
var itemNotFoundMessage = "I can't find that item, you may need to refresh my inventory page or try to copy the link again.";
var welcomeMessage1 = "Hello! To give me your trash or get something from my inventory, send me a trade offer or invite me to trade and I'll give you instructions there. \
Please remember to remove me from your friends list after you are done so that my friends list doesn't fill up. \
If you want to make trades later you can always re-add me.";
var welcomeMessage2 = "Beware of people using this bot for scams, it will take anything from anyone and give anything to anyone, don't believe anyone who says otherwise!";
var chatResponse = "Hello! To give me your trash or get something from my inventory, invite me to trade and I'll give you instructions there.";
var pausedMessage = "Sorry, I can't trade right now. I'll set my status as Looking to Trade when I'm ready to accept requests again.";
var notReadyMessage = "Sorry, I can't accept a trade request right now, wait a few minutes and try again.";
var cantAddMessage = "Sorry, I can't add that item, it might not be tradable.";
var addedMessage = "Item added, click ready when you want to make the trade";

var mongoUpdaterUrl = "http://localhost:" + secrets.mongoUpdaterPort;

// Turn on timestamps
winston.remove(winston.transports.Console);
winston.add(winston.transports.Console, {'timestamp':true});

if (fs.existsSync(serversFile)) {
	steam.servers = JSON.parse(fs.readFileSync(serversFile));
}
else {
	winston.warn("No servers file found, using defaults");
}

var sentry = undefined;
if (fs.existsSync(sentryFile)) {
	sentry = fs.readFileSync(sentryFile);
}

var bot = new steam.SteamClient();

//winston.info("Logging in with username " + secrets.username + " password " + secrets.password + " guardCode " + secrets.guardCode);
bot.logOn({ accountName: secrets.username, password: secrets.password, authCode: secrets.guardCode, shaSentryfile: sentry });

// Continuously try to connect if disconnected
setInterval(function() { 
	if (!bot.loggedOn) {
		bot.logOn(secrets.username, secrets.password, sentry, secrets.guardCode);
	}
}, 60*1000);

bot.on('loggedOn', function() { 
	winston.info("Logged on");
	bot.setPersonaState(steam.EPersonaState.Online);
	canTrade = false;
});

bot.on('error', function(error) { 
	winston.error("Caught Steam error", error);
	canTrade = false;
});

bot.on('loggedOff', function() { 
	winston.error("Logged off from Steam");
	canTrade = false;
});

bot.on('sentry', function(buffer) { 
	winston.info("Sentry event fired");
	fs.writeFile(sentryFile, buffer);
});

bot.on('servers', function(servers) {
	fs.writeFile(serversFile, JSON.stringify(servers));
});

// Auto-accept friends, auto-remove after autoFriendRemoveTimeout
bot.on('friend', function(userId, relationship) { 
	winston.info("friend event for " + userId + " type " + relationship);
	if (relationship == steam.EFriendRelationship.PendingInvitee && !_.contains(secrets.blacklist, userId)) {
		winston.info("added " + userId + " as a friend");

		request.post({ url: mongoUpdaterUrl + "/user/" + userId + "/added" }, function (error, response, body) {
			if (error) {
				winston.error("Mongo error calling added", error);
			}
		});

		bot.addFriend(userId);
		setTimeout(function() {
			bot.sendMessage(userId, welcomeMessage1);
			setTimeout(function() {
				bot.sendMessage(userId, welcomeMessage2);
			}, 1000);
		}, 5000);
		setTimeout(function() {
			if (!_.contains(secrets.whitelist, userId) && userId != secrets.ownerId) {
				winston.info("automatically removing " + userId + " as a friend");
				bot.removeFriend(userId);
			}
		}, autoFriendRemoveTimeout);
	}
});


bot.on('friendMsg', function(userId, message, entryType) { 
	winston.info("friendMsg event for " + userId + " entryType " + entryType + " message " + message);
	if (entryType == steam.EChatEntryType.ChatMsg) {

		if (userId == secrets.ownerId) {
			if (message.indexOf('game ') == 0) {
				var gameId = message.substring('game '.length);
				bot.gamesPlayed([gameId]);
				return;
			}

			switch (message) {
			case 'pause':
				paused = true;
				bot.setPersonaState(steam.EPersonaState.Snooze);
				winston.info("PAUSED");
				return;
			case 'unpause':
				paused = false;
				bot.setPersonaState(steam.EPersonaState.LookingToTrade);
				winston.info("UNPAUSED");
				return;
			case 'export anon':
				getInventoryHistory(true);
				return;
			case 'export':
				getInventoryHistory(false);
				return;
			case 'offers':
				acceptAllTradeOffers(true);
				return;
			case 'unfriend':
				removeAllFriends();
				return;
			case 'friend':
				addPendingFriends();
				return;

			//TEMPORARY
			case 'getuser':
				request.get({ url: "http://localhost:3001/user/asd" }, function (error, response, body) {
					if (error) {
						winston.error("getuser error", error);
					}
					else {
						var obj = JSON.parse(body);
						winston.info("isBlacklisted", obj.isBlacklisted);
					}
				});
				return;
			case 'added':
				request.post({ url: "http://localhost:3001/user/asd/added" }, function (error, response, body) {
					if (error) {
						winston.error("added error", error);
					}
					else {
						winston.info("added user");
					}
				});
				return;
			case 'removed':
				request.post({ url: "http://localhost:3001/user/asd/removed" }, function (error, response, body) {
					if (error) {
						winston.error("removed error", error);
					}
					else {
						winston.info("removed user");
					}
				});
				return;
			case 'getfriends':
				request.get({ url: "http://localhost:3001/users/friends" }, function (error, response, body) {
					if (error) {
						winston.error("getfriends error", error);
					}
					else {
						var obj = JSON.parse(body);
						winston.info("friends:");
						for (var i = 0; i < obj.length; i++) {
							winston.info("ID/lastAddedTime:", obj[i]._id, obj[i].lastAddedTime);
						}
					}
				});
				return;
			case 'dailytrades':
				request.get({ url: "http://localhost:3001/daily-trades/asd" }, function (error, response, body) {
					if (error) {
						winston.error("dailytrades error", error);
					}
					else {
						var obj = JSON.parse(body);
						if (obj) {
							winston.info("dailytrades for " + obj.day + " " + obj.numItemsClaimed + "/" + obj.numItemsDonated);
						} else {
							winston.info("no dailytrades today");
						}
					}
				});
				return;
			case 'tradeaccepted':
				request.post({ url: "http://localhost:3001/user/asd/trade-accepted" }, function (error, response, body) {
					if (error) {
						winston.error("tradeaccepted error", error);
					}
					else {
						winston.info("trade accepted");
					}
				});
				return;
			case 'tradedeclined':
				request.post({ url: "http://localhost:3001/user/asd/trade-declined" }, function (error, response, body) {
					if (error) {
						winston.error("tradedeclined error", error);
					}
					else {
						winston.info("trade declined");
					}
				});
				return;
			case 'trade':
				var tradeId = "" + new Date().getTime();
				var itemId = "" + new Date().getTime();
				var wasClaimed = (new Date().getTime() % 2 > 0);
				winston.info("Adding trade " + tradeId + " item " + itemId + " wasClaimed " + wasClaimed);
				request.post({ url: "http://localhost:3001/trade/asd/" + tradeId + "/" + itemId + "/" + wasClaimed }, function (error, response, body) {
					if (error) {
						winston.error("trade error", error);
					}
					else {
						winston.info("trade item added");
					}
				});
				return;
			case 'tradebody':
				var tradeId = "" + new Date().getTime();
				var itemId = "" + new Date().getTime();
				var wasClaimed = (new Date().getTime() % 2 > 0);
				winston.info("Adding trade " + tradeId + " item " + itemId + " wasClaimed " + wasClaimed);
				request.post(
				{ 
					url: "http://localhost:3001/trade/asd/" + tradeId + "/" + itemId + "/" + wasClaimed,
					json: { name: "test name{}!@#!#$$%^^&*()*&;\'\"" }
				}, function (error, response, body) {
					if (error) {
						winston.error("trade error", error);
					}
					else {
						winston.info("trade item added");
					}
				});
				return;
			//END TEMPORARY
			
			default: 
				bot.sendMessage(userId, "Unrecognized command");
				return;
			}
		}
		else {
			// disable replies since it can cause loop if other bots do the same
			//bot.sendMessage(userId, chatResponse);
		}
	}
});

bot.on('tradeProposed', function(tradeId, steamId) { 
	winston.info("Trade from " + steamId + " proposed, ID " + tradeId);

	if (_.contains(secrets.blacklist, steamId)) {
		winston.info("Blocked user " + steamId);
		bot.respondToTrade(tradeId, false);
	}
	else if (!canTrade) {
		winston.info("Can't trade");
		bot.sendMessage(steamId, notReadyMessage);
		bot.respondToTrade(tradeId, false);
	}
	else if (paused && steamId != secrets.ownerId) {
		winston.info("Paused");
		bot.sendMessage(steamId, pausedMessage);
		bot.respondToTrade(tradeId, false);
	}
	else {
		winston.info("Responding to trade");
		bot.respondToTrade(tradeId, true);
	}
});

bot.on('webSessionID', function(sessionId) {
	winston.info("Got webSessionID " + sessionId);
	webSessionId = sessionId;

	bot.webLogOn(function(newCookies) {
		winston.info("webLogOn returned " + newCookies);
		cookies = newCookies;
		storeCookieFile();

		if (!paused) {
			bot.setPersonaState(steam.EPersonaState.LookingToTrade);
		}

		canTrade = true;
		winston.info("cookies/session set up");
	});
});

bot.on('sessionStart', function(steamId) {
	winston.info("sessionStart " + steamId);
	if (!canTrade) {
		winston.info("Not ready to trade with " + steamId);
		bot.sendMessage(steamId, notReadyMessage);
	}
	else {

		var steamTrade = new SteamTrade();
		steamTrade.sessionID = webSessionId;
		_.each(cookies, function(cookie) {  
			winston.info("setting cookie " + cookie);
			steamTrade.setCookie(cookie);
		});

		steamTrade.open(steamId, function() {
			if (!paused) {
				bot.setPersonaState(steam.EPersonaState.Busy);
			}

			winston.info("steamTrade opened with " + steamId);
			steamTrade.chatMsg(sendInstructions1, function() {
			steamTrade.chatMsg(sendInstructions2, function() {
			steamTrade.chatMsg(takeInstructions1, function() {
			steamTrade.chatMsg(takeInstructions2, function() {
			steamTrade.chatMsg(takeInstructions3, function() {
			steamTrade.chatMsg(takeInstructions4, function() {
				winston.info("Instruction messages sent to " + steamId);
				var numMessages = 0;
				var claimedItems = [];

				steamTrade.on('ready', function() {
					winston.info("User is ready to trade " + steamId);
					readyUp(steamTrade, steamId);
				});

				steamTrade.on('chatMsg', function(message) {
					numMessages++;

					// Ignore spammy messages
					if (numMessages < maxTradeRequestMessages) {
						winston.info("chatMsg from " + steamId, message);
						if (message.indexOf('http://steamcommunity.com/id/' + secrets.profileId + '/inventory') != 0) {
							winston.info("Bad link");
							steamTrade.chatMsg(badLinkMessage);
						}
						else if (message == 'http://steamcommunity.com/id/'  + secrets.profileId +  '/inventory/') {
							winston.info("Wrong link");
							steamTrade.chatMsg(wrongLinkMessage, function() {
							steamTrade.chatMsg(takeInstructions1, function() {
							steamTrade.chatMsg(takeInstructions2, function() {
							steamTrade.chatMsg(takeInstructions3, function() {
							steamTrade.chatMsg(takeInstructions4) }) }) }) }); 
						}
						else {
							parseInventoryLink(steamTrade, message, function(item) {
								if (!item) {
									winston.info("No item retuned");
									steamTrade.chatMsg(itemNotFoundMessage);
								}
								else {
									//todo if count > max, can't do it
									steamTrade.addItems([item], function(res) {
										if (!res || res.length < 1 || res[0].error) {
											steamTrade.chatMsg(cantAddMessage);
										}
										else {
											claimedItems.push(item);
											steamTrade.chatMsg(addedMessage);
										}
									});
								}
							});
						}
					}
				});

				steamTrade.on('end', function(status, getItems) {
					winston.info("Trade ended with status " + status);
					if (!paused) {
						bot.setPersonaState(steam.EPersonaState.LookingToTrade);
					}
					if (status == 'complete') {
						request.post({ url: mongoUpdaterUrl + "/user/" + steamId + "/trade-accepted" }, function (error, response, body) {
							if (error) {
								winston.error("Mongo error calling trade-accepted", error);
							}
						});
						getItems(function(donatedItems) {
							var tradeId = uuid.v4();
							_.each(claimedItems, function(item) {
								postItemDetails(steamId, tradeId, item, true);
							});
							_.each(donatedItems, function(item) {
								postItemDetails(steamId, tradeId, item, false);
							});
						});

						bot.sendMessage(steamId, tradeCompleteMessage);
					}
				});
			});
			});
			});
			});
			});
			});
		});
	}
});

bot.on('tradeOffers', function(numOffers) {
	winston.info("tradeOffers event", arguments);

	if (numOffers <= 0) {
		return;
	}

	if (!canTrade) {
		winston.info("Can't accept trade offers yet");
		return;
	}
	
	// Wait a few seconds before responding
	setTimeout(function() { acceptAllTradeOffers(false); }, 10000);
});

var parseInventoryLink = function(steamTrade, message, callback) {
	var prefix = 'http://steamcommunity.com/id/' + secrets.profileId + '/inventory/#';
	if (message.indexOf(prefix) != 0) {
		prefix = 'http://steamcommunity.com/id/' + secrets.profileId + '/inventory#';
	}

	if (message.indexOf(prefix) != 0) {	
		return callback();
	}

	else {
		var itemDetails = message.substring(prefix.length);
		winston.info("Parsed item details " + itemDetails);
		if (!itemDetails) {
			return callback();
		}

		var splitDetails = itemDetails.split("_");
		winston.info("Split item details", splitDetails);
		if (splitDetails.length != 3) {
			return callback();
		}

		var appId = splitDetails[0];
		var contextId = splitDetails[1];

		steamTrade.loadInventory(appId, contextId, function(items) {
			if (!items) {
				return callback();
			}
			else {
				var result = null;
				_.each(items, function(item) {
					if (item.id == splitDetails[2]) {
						result = item;
					}
				});
				return callback(result);
			}
		});
	}
};

var readyUp = function(steamTrade, steamId) {
	steamTrade.ready(function() {
		winston.info("Set my offerings as ready with " + steamId);
		steamTrade.confirm(function() {
			winston.info("Confirmed trade with " + steamId);
		});
	});
}

var getInventoryHistory = function(anonymous) {
	var jar = cookieJar();
	var results = [];	

	requestHistoryPage(1, jar, results, function() {
		fs.writeFileSync('trades.csv', '"Trade ID","Date","Time",' + (anonymous ? "Encrypted User" : "User") + ',"Direction","Item"\n');

		_.each(results, function(historyItem) {
			//winston.info("historyItem", historyItem);
			fs.appendFileSync('trades.csv', formatHistoryItem(historyItem, anonymous));
		});

		winston.info("Finished exporting history");
	});
};

var formatHistoryItem = function(historyItem, anonymous) {
	var hmac = crypto.createHmac("sha1", secrets.hmacSecret);
	hmac.update(historyItem.user);
	encryptedUser = hmac.digest("hex");

	var row = '"' + historyItem.tradeId + '",';
	row += '"' + historyItem.date + '",';
	row += '"' + historyItem.time + '",';
	row += '"' + (anonymous ? encryptedUser : historyItem.user) + '",';
	row += '"' + historyItem.type + '",';
	row += '"' + historyItem.item + '"\n';

	return row;
};

var requestHistoryPage = function(pageNum, jar, results, callback) {
	var url = 'http://steamcommunity.com/id/' + secrets.profileId + '/inventoryhistory/?p=' + pageNum;
	winston.info("requesting page " + url);
	request({ url: url, jar: jar }, function (error, response, body) {
		if (error) {
			winston.error("request error", error);
		}
		else {
			$ = cheerio.load(body);

			var lastPage = true;
			$('.pagebtn').each(function(i, elem) {
				var $elem = $(elem);
				if ($elem.text() == '>' && !$elem.hasClass('disabled')) {
					lastPage = false;
				}
			});

			$('.tradehistoryrow').each(function(i, elem) {
				//winston.info("processing row");
				var date = $(elem).find('.tradehistory_date').text();
				var time = $(elem).find('.tradehistory_timestamp').text();
				var user = $(elem).find('.tradehistory_event_description a').attr('href');
				var tradeId = uuid.v4();

				$(elem).find('.tradehistory_items_received .history_item .history_item_name').each(function(i, itemElem) {
					results.push({ tradeId: tradeId, date: date, time: time, user: user, type: 'Received', item: $(itemElem).text() });
				});
				$(elem).find('.tradehistory_items_given .history_item .history_item_name').each(function(i, itemElem) {
					results.push({ tradeId: tradeId, date: date, time: time, user: user, type: 'Given', item: $(itemElem).text() });
				});
			});


			if (pageNum > maxTradeHistoryPage || lastPage) {
				winston.info('got to last page');
				return callback();
			}
			else {
				requestHistoryPage(pageNum + 1, jar, results, callback);
			}
		}
	});
};

var acceptAllTradeOffers = function(force) {
	if (paused && !force) {
		winston.info("Paused, can't accept trade offers");
		return;
	}

	if (respondingToTradeRequests && !force) {
		winston.info("Already responding to trade offers");
		return;
	}

	respondingToTradeRequests = true;

	// In windows, just wait a while before accepting trade again, we can't set to false on spawn 
	// exit since the cmd.exe spawn exits immediately and runs in the background
	if (secrets.environment == 'windows') {
		setTimeout(function() { respondingToTradeRequests = false; }, acceptTradeOfferTimeout);
	}

	if (secrets.environment == 'windows') {
		var offerCmd = spawn.spawn('cmd.exe', ['/c', 'casperjs accept-trade-offers.js']);
	}
	else if (secrets.environment == 'linux') {
		var offerCmd = spawn.spawn('casperjs', ['accept-trade-offers.js']);
	}

	if (offerCmd) {
		offerCmd.stdout.on('data', function (data) {
			winston.info('offerCmd stdout: ' + data);
		});

		offerCmd.stderr.on('data', function (data) {
			winston.error('offerCmd stderr: ' + data);
		});

		offerCmd.on('exit', function (data) {
			winston.info('offerCmd exited: ' + data);

			// In linux we can watch for the process exit here
			if (secrets.environment == 'linux') {
				respondingToTradeRequests = false;
			}
		});
	}
	else {
		respondingToTradeRequests = false;
	}
};

var removeAllFriends = function() {
	_.each(bot.friends, function(relationship, friendId) {
		if (relationship == steam.EFriendRelationship.Friend 
			&& !_.contains(secrets.whitelist, friendId) && friendId != secrets.ownerId) {

			winston.info("Removing friend with ID " + friendId);
			bot.removeFriend(friendId);
		}
	});
};

var addPendingFriends = function() {
	_.each(bot.friends, function(relationship, friendId) {
		if (relationship == steam.EFriendRelationship.RequestRecipient && !_.contains(secrets.blacklist, friendId)) {

			winston.info("Adding friend with ID " + friendId);
			bot.addFriend(friendId);
		}
	});
};

var splitCookie = function(cookieStr) {
	var index = cookieStr.indexOf("=");
	var name = cookieStr.substr(0,index);
	var value = cookieStr.substr(index+1);
	return { name: name, value: value };
};

var cookieJar = function() {
	var jar = request.jar();
	_.each(cookies, function(cookieStr) {
		winston.info("adding cookie to jar", cookieStr);
		var reqCookie = request.cookie(cookieStr);
		jar.add(reqCookie);
	});
	return jar;
};

var findSteamIdInReportLink = function(reportLink) {
	var re = /javascript:ReportTradeScam\(\s*'(\d+)'/;
	var match = reportLink.match(re);
	return match && match.length > 0 ? match[1] : undefined;
};

var storeCookieFile = function() {
	var cookieStr = cookies.join('; ');
	fs.writeFile(cookieFile, cookieStr);
};

var postItemDetails = function(userId, tradeId, item, wasClaimed) {
	var itemId = item.appid + "_" + item.contextid + "_" + item.id;
	var body = {};
	if (item.name) {
		body.name = item.name;
	}

	request.post(
	{ 
		url: mongoUpdaterUrl + "/trade/" + userId + "/" + tradeId + "/" + itemId + "/" + wasClaimed,
		json: body
	}, function (error, response, body) {
		if (error) {
			winston.error("Mongo error calling trade", error);
		}
	});
};