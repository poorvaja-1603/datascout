# Frontend verification checklist

Run the automated component checks with `npm test` from `frontend/` and the production compile with `npm run build`. The tests cover partial-source warnings, UNKNOWN-to-PARTIAL presentation, API authorization errors, source text rendered as text, non-HTTP source-link rejection, and dialog focus cycling/Escape behavior.

Before a release, also run this browser checklist at 360 px, 768 px, and 1280 px viewport widths:

- Use only the keyboard to sign in (or enter demo mode), search, change source checkboxes, select two datasets, compare, open a detail panel, use the copy button, and close the panel with Escape. Confirm the skip link, visible focus ring, and focus return after the panel closes.
- Confirm comparison tables scroll horizontally on narrow screens without clipping controls; verify the detail panel remains scrollable and its close control is reachable.
- Check the search loading, empty, clarification, refusal, partial-source, all-source-failed, expired-session, and successful-results states.
- Use the malicious title/explanation fixture in `src/ui.test.tsx`; confirm it displays as literal text, creates no injected element, and a `javascript:` source URL does not produce a link.
- Check normal and small text contrast against the rendered backgrounds with a WCAG contrast tool; aim for at least 4.5:1 for normal text and 3:1 for large text and controls.

The component checks do not replace the browser contrast review or a deployed Cognito/API smoke test.
