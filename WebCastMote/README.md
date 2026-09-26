# WebCastMote Custom Web Receiver

This static Web Receiver uses Google's Cast Application Framework and opts into
the Shaka HLS playback path. WebCastMote's Android relay remains responsible for
authenticated requests, browser cookies, referer headers, CORS headers, and HLS
playlist URL rewriting.

## Register and connect it

1. Host this directory at a public HTTPS URL. For development, an HTTPS tunnel
   to a local static server is sufficient.
2. In the Google Cast SDK Developer Console, create a **Custom Receiver** and
   enter the hosted `index.html` URL.
3. Add the Chromecast as a test device, wait for registration to propagate,
   and reboot it.
4. Copy the assigned receiver application ID into the root `gradle.properties`:

   ```properties
   webcastmote.castReceiverApplicationId=YOUR_RECEIVER_APP_ID
   ```

5. Rebuild and reinstall the Android app. Removing the property switches back
   to Google's Default Media Receiver (`CC1AD845`).

The receiver sends `LOAD_RECEIVED`, `PLAYER_LOAD_COMPLETE`, and
`PLAYBACK_ERROR` diagnostics back to Android. Filter Logcat by
`CastSessionController` to see them.

## Local preview

The visual shell can be served by any static file server. Playback and Cast
APIs only initialize when Google launches the page on a registered Cast device.

The custom receiver can improve compatibility for malformed HLS manifests and
sources that behave differently in Shaka. It cannot override the Chromecast's
hardware codec limits. Sources outside those limits still require a compatible
variant or transcoding in the Android relay.
