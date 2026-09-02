# Donut Overlays — website backend

This folder is the marketing site (`public/index.html`) plus the real
backend it now talks to: accounts, 7‑day free trials, Stripe subscriptions,
and a private admin page so you can see who's trialing/paying and when
each trial ends. Everything below is a checklist — do the steps in order,
send me the values as you get them, and I'll plug them in and double-check
each piece as you go.

## What's built vs what still needs your input

Built and working (server code, wired to the site):
- Sign up / log in (passwords are hashed, never stored in plain text)
- Start-a-trial → Stripe Checkout with a real 7-day trial attached to the
  subscription (Stripe handles the countdown and auto-charges after)
- A `/admin` page only you can reach: every account, their plan, trial
  end date, and renewal date
- An optional instant Discord ping the moment someone starts a trial
- Reviews: people submit one while logged in, you approve it from
  `/admin/reviews` before it shows on the site
- The Discord icon/link at the top, made configurable so you can change
  the invite later without asking me to edit code

Needs an account only you can create (I can't create these for you — they
need your email, ID/bank info, or payment card):
- A free MongoDB Atlas database (stores your users)
- A Stripe account (takes the actual payments)
- A Render account (runs the server, free tier)
- The domain itself (donutoverlays.com or whatever you land on)

Not done in this pass (tell me if you want these next):
- The color/layout customizer on the site is still just a visual preview
  — it doesn't yet save per-user or change your real overlay files in
  `1-elimination-board` / `2-auction` / `3-money-game`
- No "forgot password" flow yet
- No automatic emails (welcome email, "your trial ends tomorrow", etc.)
  — the Discord ping covers the "tell me" part for now

---

## 1. Database — MongoDB Atlas (free)

1. Go to mongodb.com/cloud/atlas/register and make a free account.
2. Create a free **M0** cluster (any region close to you).
3. Database Access → Add New Database User → give it a username/password
   (save these — you'll need them in step 5).
4. Network Access → Add IP Address → **Allow Access From Anywhere**
   (0.0.0.0/0). Render's servers don't have a fixed IP, so this is the
   normal setup for a small project like this.
5. Database → Connect → Drivers → copy the connection string. It looks
   like `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/...` —
   put your real username/password in it, and add `/donut-overlays`
   before the `?` so it picks a database name. Send me this (or just
   paste it straight into Render yourself in step 4 below).

## 2. Payments — Stripe

1. Go to stripe.com and create an account. Start in **test mode**
   (the toggle in the dashboard) — nothing here charges real cards until
   you flip it to live mode later.
2. Product catalog → Add product → "Single overlay" → recurring price,
   $8.00/month → save → copy the **Price ID** (starts `price_...`).
3. Add another product → "All overlays" → recurring price, $12.00/month
   → copy its Price ID too.
4. Developers → API keys → copy the **Secret key** (`sk_test_...`).
5. You'll add a webhook (step 4.5 below) once the server has a live URL
   — Stripe needs somewhere real to send events to first.

## 3. Put the code on GitHub (needed so Render can deploy it)

1. Create a free account at github.com if you don't have one.
2. New repository → name it `donut-overlays-website` → Create.
3. On the new repo's page, click **"uploading an existing file"** and
   drag in everything from this `4-website` folder *except* the
   `node_modules` folder if one exists (there shouldn't be one yet) —
   commit it. No command line needed.

## 4. Hosting — Render (free)

1. Go to render.com → sign up (you can use your GitHub account to sign
   in, which makes step 2 easier).
2. New → Web Service → connect the `donut-overlays-website` repo.
3. Settings: Runtime = Node, Build command = `npm install`,
   Start command = `npm start`, Instance type = Free.
4. Before deploying, add these **Environment Variables** (Render's UI,
   not a `.env` file):
   - `MONGODB_URI` — from step 1
   - `JWT_SECRET` — any long random string (mash the keyboard, 40+ chars)
   - `STRIPE_SECRET_KEY` — from step 2
   - `STRIPE_PRICE_SINGLE` / `STRIPE_PRICE_ALL` — the two price IDs
   - `ADMIN_PASSWORD` — a password only you know, for the `/admin` page
   - `PUBLIC_URL` — leave this as the `https://xxxxx.onrender.com` URL
     Render shows you before you have a domain; update it once the real
     domain is live (step 6)
   - `DISCORD_INVITE` — your server's invite link (send it to me or set
     it yourself any time — no redeploy needed, just restart the service)
   - `DISCORD_NOTIFY_WEBHOOK_URL` — optional, see step 7
   - Leave `STRIPE_WEBHOOK_SECRET` blank for now — next step.
5. Deploy. Once it's live, note the `https://xxxxx.onrender.com` address.

### 4.5 Stripe webhook (tells your server "they paid" / "trial started")

1. Stripe dashboard → Developers → Webhooks → Add endpoint.
2. Endpoint URL: `https://xxxxx.onrender.com/webhook` (your Render URL).
3. Select events: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`.
4. Copy the **Signing secret** (`whsec_...`) → add it to Render as
   `STRIPE_WEBHOOK_SECRET` → the service will restart automatically.

### Test it end to end (still in Stripe test mode)

Visit your Render URL, sign up, click a plan, join the Discord, and pay
with Stripe's test card `4242 4242 4242 4242`, any future expiry, any
CVC. You should land back on the site, and `https://xxxxx.onrender.com
/admin` (log in with `admin` / your `ADMIN_PASSWORD`) should show your
account as **trialing** with a trial-end date 7 days out.

When you're ready to take real money: in Stripe, switch to **live mode**,
redo steps 2 and 4.5 in live mode (live products have different Price
IDs, and you need a separate live webhook), and swap `STRIPE_SECRET_KEY`
/ `STRIPE_PRICE_SINGLE` / `STRIPE_PRICE_ALL` / `STRIPE_WEBHOOK_SECRET` on
Render for the live versions.

## 5. Domain

Buy `donutoverlays.com` (or a backup name if it's taken) at Cloudflare
Registrar or Namecheap — roughly $10–12/year, paid with your own card.
I can't buy it for you, but I can check what's available and help you
pick a backup name if you want.

## 6. Point the domain at Render

1. Render → your service → Settings → Custom Domains → Add
   `donutoverlays.com` and `www.donutoverlays.com`.
2. Render shows you the exact DNS records to add (usually an A/ALIAS
   record for the bare domain and a CNAME for `www`). Add those in your
   registrar's DNS settings.
3. Wait 10–60 minutes for it to take effect — Render issues free SSL
   automatically once it sees the DNS pointed at it.
4. Update the `PUBLIC_URL` environment variable on Render to
   `https://donutoverlays.com`, and update the Stripe webhook URL
   (step 4.5) to use the new domain too.

## 7. Optional: instant Discord ping on every new trial

1. In your Discord server: Server Settings → Integrations → Webhooks →
   New Webhook → pick a channel (e.g. `#trial-alerts`) → Copy Webhook URL.
2. Paste it into Render as `DISCORD_NOTIFY_WEBHOOK_URL`.

From then on, the moment someone's trial starts, your server posts a
message there with their email, plan, and the exact date the trial ends
— on top of always being able to check `/admin` for the full list.

## Using the admin page day to day

- `https://donutoverlays.com/admin` — every account: email, status
  (trialing/active/past_due/canceled), plan, trial end date, next
  renewal date, and signup date.
- `https://donutoverlays.com/admin/reviews` — approve or delete reviews
  people submit before they go live on the site.

Log in with username `admin` and whatever you set `ADMIN_PASSWORD` to.

## Testing on your own PC first (optional)

If you want to try it locally before touching Render: copy
`.env.example` to `.env`, fill in real values, then run:

```
npm install
npm start
```

and open `http://localhost:8080`. (Your PC has normal internet access,
so `npm install` will work fine there even though it can't run inside
this chat session.)
