# Personal Messenger and Gemini website chats

These are not implemented connectors. No cookies, browser sessions or chat exports have been collected.

## Messenger

Meta's Messenger Platform documents Page messaging and Page tokens/permissions. Do not treat a Page integration as access to an owner's personal Messenger inbox. Personal history may be imported from the owner's own Meta data export; encrypted history can require a separate secure-storage download. The file format must be inspected privately before implementing an importer. Import source content as untrusted retrieved documents, not automatically accepted personal-memory facts.

References: https://developers.facebook.com/docs/messenger-platform/ and https://www.facebook.com/help/messenger-app/677912386869109 . Meta documentation may require a browser/login. Its encryption architecture is described at https://engineering.fb.com/2023/12/06/security/building-end-to-end-security-for-messenger/ .

## Gemini

Google documents exporting Gemini conversations through Google Takeout: My Activity → Gemini Apps. The separate Gemini category is for Gems data. A developer Gemini API integration should not be presented as access to existing chats in the Gemini consumer website. Exported-history import and new API conversations are distinct features.

Reference: https://support.google.com/gemini/answer/16920332?hl=en .

## Optional local browser access

A future companion/browser integration could use an owner-controlled, separately logged-in browser profile or explicitly shared tab content. Keep authentication state on the owner's device; never paste cookies into chat or upload the browser profile to GitHub. Browser state can permit account impersonation. Use explicit domain/tab/read permissions and owner review before sending any message. Website automation can break after UI changes and cannot be promised to work around login, CAPTCHA or encrypted-history restrictions. Do not claim background access to an entire personal account from a browser permission to read one tab.

Reference: https://playwright.dev/docs/auth . No authentication bypass or cookie-replay implementation is included.
