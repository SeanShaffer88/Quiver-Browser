/**
 * Well-known advertising, analytics and tracking hosts, curated for Quiver. A request to one of these hosts (or any
 * subdomain) from a page on a different site is cancelled. The list ships with the app and is never fetched, so it
 * reveals nothing about what you browse. Entries are kept to hosts whose only job is ads or tracking: broad domains
 * that also serve real content (sign-in, CDNs, logos, deep links, consent banners) are left out on purpose, because
 * blocking them breaks sites.
 */
export const BLOCKED_DOMAINS: readonly string[] = [
  // Google ads and analytics
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com', 'google-analytics.com',
  'googletagmanager.com', 'adservice.google.com', '2mdn.net', 'admob.com', 'adsense.com', 'app-measurement.com',
  'googleoptimize.com', 'urchin.com',
  // Social network pixels and ad endpoints
  'connect.facebook.net', 'pixel.facebook.com', 'an.facebook.com', 'analytics.facebook.com',
  'ads.linkedin.com', 'px.ads.linkedin.com', 'snap.licdn.com',
  'analytics.twitter.com', 'ads-twitter.com', 'ads-api.twitter.com',
  'analytics.tiktok.com', 'ads.tiktok.com', 'business-api.tiktok.com',
  'ads.pinterest.com', 'ct.pinterest.com', 'log.pinterest.com', 'analytics.pinterest.com',
  'sc-static.net', 'tr.snapchat.com', 'ads.reddit.com', 'events.reddit.com', 'alb.reddit.com',
  // Microsoft
  'bat.bing.com', 'bat.r.msn.com', 'clarity.ms', 'ads.msn.com',
  // Ad exchanges, SSPs and DSPs
  'adnxs.com', 'adnxs-simple.com', 'appnexus.com', 'xandr.com', 'adsrvr.org', 'adsrvr.com', 'criteo.com', 'criteo.net',
  'rubiconproject.com', 'pubmatic.com', 'openx.net', 'openx.com', 'casalemedia.com', 'indexww.com', 'contextweb.com',
  'sovrn.com', 'lijit.com', '33across.com', 'sharethrough.com', 'triplelift.com', '3lift.com', 'yieldmo.com',
  'gumgum.com', 'teads.tv', 'teads.com', 'smartadserver.com', 'sascdn.com', 'adform.net', 'adformdsp.net',
  'amazon-adsystem.com', 'assoc-amazon.com', 'media.net', 'medianet.com', 'yieldlab.net', 'improvedigital.com',
  'spotxchange.com', 'spotx.tv', 'springserve.com', 'lkqd.net', 'tremorhub.com', 'telaria.com',
  'yahoo-adserver.com', 'ads.yahoo.com', 'analytics.yahoo.com', 'advertising.com', 'adtech.de', 'adtechus.com',
  'atdmt.com', 'atwola.com', 'serving-sys.com', 'sizmek.com', 'flashtalking.com', 'innovid.com',
  'adroll.com', 'nextroll.com', 'perfectaudience.com', 'bidswitch.net', 'bidr.io', 'simpli.fi', 'sitescout.com',
  'adkernel.com', 'smaato.net', 'mathtag.com', 'mediamath.com', 'turn.com', 'dataxu.com', 'w55c.net',
  'rtbhouse.com', 'creativecdn.com', 'stackadapt.com', 'beeswax.com', 'avocet.io', 'betweendigital.com',
  'bidtellect.com', 'brealtime.com', 'conversantmedia.com', 'dotomi.com', 'districtm.io', 'dmxleo.com',
  'e-planning.net', 'emxdgt.com', 'freewheel.tv', 'fwmrm.net', 'kargo.com', 'loopme.com', 'onetag-sys.com',
  'pubnative.net', 'revjet.com', 'rhythmone.com', 'seedtag.com', 'smilewanted.com', 'sonobi.com', 'synacor.com',
  'the-ozone-project.com', 'undertone.com', 'unrulymedia.com', 'vidazoo.com', 'widespace.com', 'zedo.com',
  'adhese.com', 'adition.com', 'adition.net', 'adocean.pl', 'adscale.de', 'adspirit.de', 'adswizz.com',
  'adtelligent.com', 'adzerk.net', 'aniview.com', 'connatix.com', 'primis.tech', 'admixer.net', 'adgrx.com',
  'adhigh.net', 'admanmedia.com', 'mfadsrvr.com', 'mookie1.com', 'media6degrees.com', 'dstillery.com',
  'owneriq.net', 'rfihub.com', 'rfihub.net', 'nanigans.com', 'speedshiftmedia.com', 'justpremium.com',
  'yieldlove.com', 'valueimpression.com', 'viralize.tv', 'quantumdex.io', 'ipredictive.com', 'hybrid.ai',
  // Publisher ad networks and monetization scripts
  'adthrive.com', 'mediavine.com', 'ezoic.net', 'ezodn.com', 'ezojs.com', 'playwire.com', 'adpushup.com',
  'monetizer101.com', 'infolinks.com', 'vibrantmedia.com', 'kontera.com', 'buysellads.com', 'carbonads.com',
  'carbonads.net', 'adsco.re', 'adlightning.com', 'adloox.com', 'admedo.com', 'adnium.com',
  // Native ad and content recommendation widgets
  'taboola.com', 'taboolasyndication.com', 'outbrain.com', 'outbrainimg.com', 'zemanta.com', 'revcontent.com',
  'mgid.com', 'content.ad', 'plista.com', 'ligatus.com', 'nativeads.com', 'nativo.com', 'ntv.io',
  'postrelease.com', 'engageya.com', 'zergnet.com',
  // Pop-up, push and adult ad networks
  'exoclick.com', 'juicyads.com', 'trafficjunky.com', 'trafficjunky.net', 'propellerads.com', 'popads.net',
  'popcash.net', 'adcash.com', 'hilltopads.net', 'adsterra.com', 'clickadu.com', 'admaven.com', 'richpush.co',
  'pushcrew.com', 'pushengage.com',
  // Ad verification and viewability measurement
  'doubleverify.com', 'adsafeprotected.com', 'moatads.com', 'moatpixel.com', 'iasds01.com', 'adsymptotic.com',
  'pixalate.com',
  // Data brokers and identity graphs
  'rlcdn.com', 'tapad.com', 'crwdcntrl.net', 'lotame.com', 'agkn.com', 'eyeota.net', 'exelator.com', 'bluekai.com',
  'krxd.net', 'demdex.net', 'id5-sync.com', 'liadm.com', 'liveintent.com', 'pippio.com', 'intentiq.com',
  'uidapi.com', 'parrable.com', 'zeotap.com', 'semasio.net', 'adbrn.com', 'zqtk.net', 'bombora.com', 'ml314.com',
  'mediarithmics.com', 'weborama.fr', 'weborama.com',
  // Audience measurement
  'scorecardresearch.com', 'comscore.com', 'voicefive.com', 'imrworldwide.com', 'quantserve.com',
  'quantcount.com', 'quantcast.com', 'chartbeat.com', 'chartbeat.net', 'gemius.pl', 'ioam.de', 'xiti.com',
  'ati-host.net', 'at-o.net', 'tns-counter.ru', 'top-fwz1.mail.ru', 'top.mail.ru', 'counter.yadro.ru',
  'mc.yandex.ru', 'an.yandex.ru', 'yandexadexchange.net', 'adfox.ru', 'hm.baidu.com', 'cpro.baidu.com',
  'pos.baidu.com', 'cnzz.com', 'umeng.com', 'tanx.com', 'mmstat.com', 'gridsumdissector.com',
  // Product analytics, session replay and A/B testing
  'hotjar.com', 'hotjar.io', 'mouseflow.com', 'crazyegg.com', 'luckyorange.com', 'luckyorange.net',
  'fullstory.com', 'inspectlet.com', 'smartlook.com', 'logrocket.com', 'logrocket.io', 'sessioncam.com',
  'decibelinsight.net', 'quantummetric.com', 'contentsquare.net', 'clicktale.net', 'glassbox.com',
  'mixpanel.com', 'mxpnl.com', 'mxpnl.net', 'cdn.segment.com', 'api.segment.io', 'segment.io', 'amplitude.com',
  'heapanalytics.com', 'heap.io', 'kissmetrics.com', 'kissmetrics.io', 'parsely.com', 'parse.ly', 'nr-data.net',
  'js-agent.newrelic.com', 'optimizely.com', 'vwo.com', 'visualwebsiteoptimizer.com', 'abtasty.com',
  'kameleoon.com', 'kameleoon.eu', 'convertexperiments.com', 'statcounter.com', 'histats.com', 'clicky.com',
  'getclicky.com', 'woopra.com', 'gosquared.com', 'etracker.com', 'etracker.de', 'econda-monitor.de',
  'webtrekk.net', 'wt-eu02.net', 'webtrends.com', 'webtrendslive.com', 'wt-safetag.com', 'coremetrics.com',
  'cmcore.com', 'mparticle.com', 'dynamicyield.com', 'monetate.net', 'certona.net', 'richrelevance.com',
  'yieldify.com', 'bounceexchange.com', 'bouncex.net', 'evergage.com', 'siteintercept.qualtrics.com',
  'foresee.com', 'iperceptions.com', 'kampyle.com', 'trackjs.com', 'noibu.com',
  // Adobe marketing cloud
  'omtrdc.net', 'everesttech.net', '2o7.net', 'adobedtm.com', 'omniture.com',
  // Tag managers and customer data platforms used for tracking
  'tealiumiq.com', 'tiqcdn.com', 'ensighten.com', 'blueconic.net', 'permutive.com', 'permutive.app',
  // B2B visitor identification and marketing automation tracking
  'pardot.com', 'marketo.net', 'mktoresp.com', 'eloqua.com', 'en25.com', 'hs-analytics.net', 'hs-banner.com',
  'hsadspixel.net', 'hsleadflows.net', 'leadfeeder.com', 'lfeeder.com', 'leadforensics.com', 'albacross.com',
  '6sc.co', 'demandbase.com', 'bizible.com', 'ws.zoominfo.com', 'zi-scripts.com', 'a.klaviyo.com',
  'attentivemobile.com', 'listrakbi.com', 'cquotient.com', 'emarsys.net', 'exponea.com',
  // Mobile attribution
  'appsflyer.com', 'adjust.com', 'adjust.io', 'kochava.com', 'singular.net', 'mopub.com', 'applovin.com',
  'vungle.com', 'chartboost.com', 'adcolony.com', 'supersonicads.com', 'tapjoy.com', 'startapp.com', 'inmobi.com',
  // Affiliate tracking and link rewriting
  'skimlinks.com', 'skimresources.com', 'viglink.com', 'linksynergy.com', 'awin1.com', 'dpbolvw.net',
  'anrdoezrs.net', 'jdoqocy.com', 'kqzyfj.com', 'tkqlhce.com', 'emjcd.com', 'tradedoubler.com',
  'tradetracker.net', 'webgains.com', 'affilinet.com', 'zanox.com', 'belboon.de', 'adcell.de', 'prf.hn',
  'go2cloud.org', 'hasoffers.com', 'avantlink.com', 'flexoffers.com',
  // Share-button trackers
  'addthis.com', 'addthisedge.com', 'sharethis.com', 'shareaholic.com', 'po.st', 'tynt.com', 'disqusads.com',
];
