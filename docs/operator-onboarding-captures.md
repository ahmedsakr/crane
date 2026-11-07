# Operator onboarding captures

These optional commands exercise the finished Operators and public Join views in
an environment that permits local servers and Chromium. They have not been run
in Codex's restricted sandbox. Operator pre-approval authorizes Crane to record
a candidate waiver; it does not mean these views have been inspected.

Build first, then capture the operator list, the invite sheet after creation and
an operator's management sheet at wide, short and phone sizes. The screenshot
tool seeds a throwaway admin; the password below is for that demo only.

```sh
npm run build -w web &&
for size in 1280x800 1280x600 390x844; do
  npm run screenshot -- /operators --size "$size" \
    --operator robin --password 'demo-password-123' --sign-in \
    --wait-for '[data-operator="robin"]' \
    --shot ".crane/screenshots/operators-$size.png" \
    --click '.page-head .btn-primary' \
    --click '.sheet-pane-foot .btn-primary' \
    --wait-for '.operator-link' \
    --shot ".crane/screenshots/invite-$size.png" \
    --key Escape --click '[data-operator="robin"]' \
    --wait-for '.operator-actions' \
    --out ".crane/screenshots/operator-sheet-$size.png" || break
done
```

Create a valid invite through the API, sign the admin out, then open its fragment
link on the anonymous device. The evaluation prints no token. Capture Join in
dark mode, followed by an invalid link with no form, at each required size.

```sh
npm run build -w web &&
for size in 1280x800 1280x600 390x844; do
  npm run screenshot -- /operators --size "$size" \
    --media prefers-color-scheme=dark \
    --operator robin --password 'demo-password-123' --sign-in \
    --wait-for '[data-operator="robin"]' \
    --eval '(async () => { const r = await fetch("/api/operators/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "operator", name: "Sam" }) }); if (!r.ok) throw new Error("Invite failed"); const { path } = await r.json(); const out = await fetch("/api/auth/sign-out", { method: "POST" }); if (!out.ok) throw new Error("Sign-out failed"); setTimeout(() => location.assign(path), 0); return "Opening invite"; })()' \
    --wait-for '.join-card input[name="username"]' \
    --eval '(() => { if (location.hash) throw new Error("Fragment was not cleared"); return "Fragment cleared"; })()' \
    --shot ".crane/screenshots/join-$size.png" \
    --eval 'location.assign("/join#invalid-link")' \
    --wait-for '.join-card .sign-in-error' \
    --out ".crane/screenshots/join-invalid-$size.png" || break
done
```

Open the PNGs and inspect clipping, overflow, legibility and scrolling, especially
the short sheet bodies and phone form. These sequences produce 15 images;
Crane retains at most 12 images per task, so select attachments accordingly and
keep the remaining captures locally.

For optional behavioral inspection, use the valid Join screen to enter a name,
a unique username and matching passwords of at least 12 characters. Submit
**Join** and confirm Home, a welcome toast and a signed-in account. Reopen the
used link and confirm no form. As the admin, create a reset from an operator's
sheet, open it signed out, and confirm setting matching passwords signs that
operator in and opens Home. Verify Copy, role changes, revocation, sign-out,
the named Remove confirmation and the inline last-admin error. Sign in as an
operator and confirm the Operators menu entry and list remain available with
no management controls. No further operator visual decision is required while
the recorded pre-approval remains active; Crane verifies candidate coverage.
