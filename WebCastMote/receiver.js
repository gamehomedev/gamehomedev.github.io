(() => {
    'use strict';

    const DIAGNOSTICS_NAMESPACE =
        'urn:x-cast:com.gamehomedev.webcastmote.diagnostics';
    const HLS_CONTENT_TYPE = 'application/x-mpegurl';

    const context = cast.framework.CastReceiverContext.getInstance();
    const playerManager = context.getPlayerManager();

    const broadcastDiagnostic = (type, details = {}) => {
        const payload = {
            type,
            timestamp: new Date().toISOString(),
            ...details,
        };
        console.log('[WebCastMote]', payload);
        try {
            context.sendCustomMessage(DIAGNOSTICS_NAMESPACE, undefined, payload);
        } catch (error) {
            console.warn('[WebCastMote] Unable to send diagnostics', error);
        }
    };

    playerManager.setMessageInterceptor(
        cast.framework.messages.MessageType.LOAD,
        (request) => {
            const media = request.media;
            if (!media) {
                return request;
            }

            const url = media.contentUrl || media.contentId || '';
            const declaredType = (media.contentType || '').toLowerCase();
            const looksLikeHls =
                declaredType.includes('mpegurl') ||
                /(?:\.m3u8?(?:$|\?)|\/m3u8?\/|\/hls\/|\/list\/)/i.test(url);

            if (looksLikeHls) {
                media.contentType = HLS_CONTENT_TYPE;
            }

            const details = media.customData || {};
            const width = Number(details.width) || undefined;
            const height = Number(details.height) || undefined;
            const frameRate = Number(details.frameRate) || undefined;
            const codecs = details.codecs || undefined;
            // For HLS / MPEG-TS streams we skip canDisplayType entirely.
            // The native CAF player (useShakaForHls=false) handles MPEG-TS HLS
            // natively on Chromecast, but canDisplayType("video/mp2t") returns
            // false on most devices even when playback would succeed.  Blocking
            // on that result causes a spurious PLAYBACK_REJECTED / error 905.
            const isMpegTsHls =
                looksLikeHls && details.container === 'HLS_MPEG2_TS';

            let canDisplay = true;
            let capabilityType = null;
            if (!isMpegTsHls && codecs) {
                // Only run the capability check for non-HLS direct media where
                // MSE codec support actually matters.
                capabilityType = media.contentType;
                canDisplay = context.canDisplayType(
                    capabilityType,
                    codecs,
                    width,
                    height,
                    frameRate,
                );
            }

            broadcastDiagnostic('CAPABILITY_CHECK', {
                supported: canDisplay,
                contentType: capabilityType || null,
                codecs: codecs || null,
                width: width || null,
                height: height || null,
                frameRate: frameRate || null,
                skipped: isMpegTsHls || !codecs,
            });

            if (!canDisplay) {
                broadcastDiagnostic('PLAYBACK_REJECTED', {
                    reason: 'VIDEO_FORMAT_NOT_SUPPORTED',
                    codecs: codecs || null,
                    width: width || null,
                    height: height || null,
                });
                return null; // tell CAF to reject cleanly
            }

            broadcastDiagnostic('LOAD_RECEIVED', {
                url,
                contentType: media.contentType || null,
                streamType: media.streamType || null,
                playbackEngine: isMpegTsHls ? 'shaka-hls-mpegts' : looksLikeHls ? 'shaka-hls' : 'caf-default',
            });
            return request;
        },
    );

    playerManager.addEventListener(
        cast.framework.events.EventType.ERROR,
        (event) => {
            broadcastDiagnostic('PLAYBACK_ERROR', {
                detailedErrorCode: event.detailedErrorCode ?? null,
                reason: event.reason ?? null,
                severity: event.severity ?? null,
                triggeredByEventType: event.triggeredByEventType ?? null,
                error: event.error ? String(event.error) : null,
            });
        },
    );

    playerManager.addEventListener(
        cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
        () => broadcastDiagnostic('PLAYER_LOAD_COMPLETE'),
    );

    // Fires when Shaka selects an audio or video bitrate variant.
    // A missing VIDEO entry here means Shaka found no playable video track.
    playerManager.addEventListener(
        cast.framework.events.EventType.BITRATE_CHANGED,
        (event) => {
            broadcastDiagnostic('BITRATE_CHANGED', {
                totalBitrate: event.totalBitrate ?? null,
                audioBitrate: event.audioBitrate ?? null,
                videoBitrate: event.videoBitrate ?? null,
            });
        },
    );

    // Fires when playback stalls waiting for data.
    playerManager.addEventListener(
        cast.framework.events.EventType.BUFFERING,
        (event) => {
            broadcastDiagnostic('BUFFERING', { isBuffering: event.isBuffering });
        },
    );

    // PLAYER_LOAD_BEGIN fires right before Shaka starts loading content.
    // Use it as a belt-and-suspenders place to apply forceTransmux directly
    // on the Shaka instance in case shakaConfiguration is silently ignored.
    playerManager.addEventListener(
        cast.framework.events.EventType.PLAYER_LOAD_BEGIN,
        () => {
            try {
                // cast.player is the underlying Shaka player in CAF.
                const shaka = cast.player && cast.player.api
                    ? cast.player.api.getPlayer()
                    : null;
                if (shaka && typeof shaka.configure === 'function') {
                    shaka.configure('streaming.forceTransmux', true);
                    broadcastDiagnostic('SHAKA_CONFIGURED', { forceTransmux: true });
                } else {
                    broadcastDiagnostic('SHAKA_CONFIGURE_SKIPPED',
                        { reason: 'no Shaka instance found via cast.player.api' });
                }
            } catch (e) {
                broadcastDiagnostic('SHAKA_CONFIGURE_FAILED', { error: String(e) });
            }
        },
    );

    const playbackConfig = new cast.framework.PlaybackConfig();
    playbackConfig.autoResumeNumberOfSegments = 1;
    playbackConfig.manifestRequestHandler = (requestInfo) => {
        requestInfo.withCredentials = false;
        return requestInfo;
    };
    playbackConfig.segmentRequestHandler = (requestInfo) => {
        requestInfo.withCredentials = false;
        return requestInfo;
    };
    playbackConfig.manifestHandler = (manifest) =>
        manifest.replace(/^\uFEFF/, '').trimStart();

    const options = new cast.framework.CastReceiverOptions();
    options.statusText = 'Ready to cast';
    // Use Shaka (MSE) for HLS instead of the native player.
    // The native CAF player silently drops video frames for MPEG-TS streams
    // with non-16-aligned widths (e.g. 1936px) due to a chroma siting issue
    // in the Chromecast compositor — audio plays but video is black.
    // Shaka demuxes MPEG-TS correctly and feeds clean frames to the video
    // element, which resolves audio-only playback on those streams.
    options.useShakaForHls = true;
    // Allow Shaka to transmux MPEG-TS segments into fMP4 (MP4/MSE) so it
    // does not reject streams it cannot play natively in the browser.
    // Also applied directly via PLAYER_LOAD_BEGIN as a belt-and-suspenders fallback.
    options.shakaConfiguration = {
        streaming: {
            // Force mp2t → fMP4 transmuxing on the fly.
            forceTransmux: true,
        },
    };
    options.playbackConfig = playbackConfig;
    options.customNamespaces = {
        [DIAGNOSTICS_NAMESPACE]: cast.framework.system.MessageType.JSON,
    };
    options.versionCode = 7;

    context.start(options);
})();
