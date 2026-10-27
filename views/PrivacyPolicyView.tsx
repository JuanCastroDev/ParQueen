import React from 'react';
import { ChevronLeft } from 'lucide-react';

export const PrivacyPolicyView = ({ onBack }: { onBack: () => void }) => (
  <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)] pt-4 pb-20 px-4 max-w-2xl mx-auto">
    <header className="flex items-center gap-4 mb-6">
      <button onClick={onBack} aria-label="Back to ParQueen" className="w-10 h-10 rounded-full flex items-center justify-center bg-white/5 border border-[var(--color-border)] text-[var(--color-text)] hover:bg-white/10 transition-all shrink-0">
        <ChevronLeft size={20} aria-hidden="true" />
      </button>
      <h1 className="text-xl font-bold text-[var(--color-text)] tracking-wide">Privacy Policy</h1>
    </header>

    <article className="bg-[var(--color-card)] border border-[var(--color-border)] backdrop-blur-md rounded-3xl p-5 shadow-xl text-[var(--color-text-secondary)] text-sm leading-relaxed space-y-4">
      <p>
        <strong>Effective Date:</strong> May 11, 2026<br />
        <strong>Last Updated:</strong> October 13, 2026
      </p>

      <section aria-labelledby="privacy-introduction">
        <h2 id="privacy-introduction" className="text-base font-bold text-[var(--color-text)] mb-2">1. Introduction</h2>
        <p>ParQueen (“we,” “us,” or “our”) provides community parking tools. This policy explains what information the current service handles, why it is used, and the choices available to you. It does not promise rights or retention periods beyond those required by applicable law.</p>
      </section>

      <section aria-labelledby="privacy-information">
        <h2 id="privacy-information" className="text-base font-bold text-[var(--color-text)] mb-2">2. Information We Handle</h2>
        <ul className="list-disc pl-5 space-y-2">
          <li><strong>Account and profile information:</strong> Your phone-authentication account, display name, username, optional verified email and profile details, vehicle information, avatar, language, theme, and account preferences.</li>
          <li><strong>Location information:</strong> With browser or device permission, ParQueen uses precise location to show nearby Pings, support map search and directions, save My Car, create parking reminders, and provide Street Intelligence. While location-enabled map tracking is active, ParQueen automatically stores a geohash derived from your current location and an update timestamp to identify candidates for optional nearby parking alerts. Location is also stored when you deliberately create a Ping, save your car, or use another feature that needs a saved location.</li>
          <li><strong>Community activity:</strong> Pings, claims, handoff status and feedback, parking history, messages, reports, moderation information, and trust or Crown events.</li>
          <li><strong>Photos and AI inputs:</strong> Sign photos you choose to scan, avatar photos, and message context submitted when smart-reply assistance is used.</li>
          <li><strong>Push-notification information:</strong> Notification preferences, a Firebase Cloud Messaging registration token for the browser, and delivery-related metadata.</li>
          <li><strong>Technical and safety information:</strong> Limited request, error, device, security, and abuse-prevention metadata generated when the service is used.</li>
          <li><strong>Optional product analytics:</strong> If you enable analytics in Settings, ParQueen may send limited usage events to PostHog, including opening the map, starting or creating a Ping, beginning a parking claim, and recording a handoff outcome. Events use a randomly generated analytics identifier and an event identifier. Our intended event payload excludes Firebase account IDs, phone numbers, email addresses, precise parking coordinates, addresses, chat contents, page URLs, and custom event properties.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-use">
        <h2 id="privacy-use" className="text-base font-bold text-[var(--color-text)] mb-2">3. How We Use Information</h2>
        <ul className="list-disc pl-5 space-y-2">
          <li>Authenticate accounts and maintain profiles and preferences.</li>
          <li>Display community parking information, coordinate claims and handoffs, support messaging, and maintain trust and safety.</li>
          <li>Provide maps, nearby results, walking directions, parking reminders, and street-rule guidance.</li>
          <li>Deliver optional parking alerts after you explicitly enable browser notifications.</li>
          <li>Process explicit AI-assisted requests. AI explanations and suggestions are advisory and may be incomplete or incorrect; posted signs and current law remain authoritative.</li>
          <li>Diagnose failures, secure the service, enforce limits, investigate reports, and prevent abuse.</li>
        </ul>
        <p className="mt-2">We do not sell personal information or use location and Ping history to train an internal parking-prediction model.</p>
      </section>

      <section aria-labelledby="privacy-providers">
        <h2 id="privacy-providers" className="text-base font-bold text-[var(--color-text)] mb-2">4. Service Providers and Data Sources</h2>
        <p>Information is shared only as needed to operate the requested feature or protect the service:</p>
        <ul className="list-disc pl-5 space-y-2 mt-2">
          <li><strong>Firebase and Google Cloud:</strong> Authentication, database and file storage, Cloud Functions, push delivery, avatar safety review, and supporting infrastructure.</li>
          <li><strong>Mapbox:</strong> Interactive maps, address search, reverse geocoding, and walking directions. Map requests can include search text or coordinates.</li>
          <li><strong>Google Gemini:</strong> Sign interpretation and smart-reply assistance for content you explicitly submit.</li>
          <li><strong>SendGrid:</strong> Delivery of email-verification codes when you add an email address.</li>
          <li><strong>Sentry:</strong> Production exception monitoring. ParQueen configures it without default personal information and removes user data, request headers, cookies, bodies, query strings, and full URLs before sending events. Session Replay, tracing, profiling, and Sentry logging are not enabled.</li>
          <li><strong>PostHog US Cloud:</strong> Optional product analytics, enabled only with your consent. ParQueen intends to send a limited set of interaction events with anonymous identifiers, not parking locations or message contents. PostHog may receive technical connection metadata when requests are made. We configure client IP discarding and disable automatic tracking and Session Replay. Provider-controlled retention and deletion practices also apply.</li>
          <li><strong>Public street-data providers:</strong> Sources such as NYC Open Data, SweepNYC, and OpenStreetMap may receive a location or street-area query needed to retrieve public parking information.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-choices">
        <h2 id="privacy-choices" className="text-base font-bold text-[var(--color-text)] mb-2">5. Your Choices</h2>
        <ul className="list-disc pl-5 space-y-2">
          <li><strong>Location:</strong> You can decline or revoke location permission. Features that depend on current location will be limited.</li>
          <li><strong>Notifications:</strong> Parking alerts are optional. You can disable the product preference or change browser or device permission at any time.</li>
          <li><strong>Product analytics:</strong> Analytics are off by default. You can enable or disable them in Settings. Turning them off blocks new analytics collection by the app immediately. A preference change made offline may take time to synchronize with the server, and requests already in progress may finish. Previously collected events may remain subject to the provider's retention and applicable deletion practices.</li>
          <li><strong>Profile and communications:</strong> You can edit supported profile fields, leave optional fields blank, delete chats where available, block users, and report safety concerns.</li>
          <li><strong>Account deletion:</strong> Settings provides an authenticated deletion flow. It removes account, profile, private preference, notification-token, parking-session, message, avatar, and authentication data covered by the deletion service. Records needed for another participant’s history, safety, fraud prevention, or legal obligations may instead be minimized or anonymized.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-retention">
        <h2 id="privacy-retention" className="text-base font-bold text-[var(--color-text)] mb-2">6. Storage, Retention, and Security</h2>
        <p>We keep information only while it is needed to provide the feature, maintain safety and security, resolve reports, or meet legal obligations. Different records have different operational lifetimes, and provider logs or backups may follow provider-controlled schedules. We use access controls and encrypted network connections, but no online service can guarantee absolute security.</p>
      </section>

      <section aria-labelledby="privacy-children">
        <h2 id="privacy-children" className="text-base font-bold text-[var(--color-text)] mb-2">7. Children</h2>
        <p>ParQueen is not directed to children under 13. If you believe a child under 13 provided personal information, contact us so it can be reviewed and removed where required.</p>
      </section>

      <section aria-labelledby="privacy-changes">
        <h2 id="privacy-changes" className="text-base font-bold text-[var(--color-text)] mb-2">8. Changes to This Policy</h2>
        <p>We may update this policy when the service or applicable requirements change. The current version and update date will remain available on this page.</p>
      </section>

      <section aria-labelledby="privacy-contact">
        <h2 id="privacy-contact" className="text-base font-bold text-[var(--color-text)] mb-2">9. Contact</h2>
        <p>Privacy questions or requests can be sent to <a href="mailto:privacy@parqueen.app" className="text-[var(--color-info)] hover:underline">privacy@parqueen.app</a>.</p>
      </section>
    </article>
  </div>
);
