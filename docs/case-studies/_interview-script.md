# Case-Study Interview Script — Compendiq

_Founder-facing reference. Target length: **30 minutes**. Keep the conversation loose; the structure below is a checklist, not a script to read aloud._

**Before the call**

- [ ] Signed consent on file (`_consent-template.md`).
- [ ] Confirm recording permission in the first 30 seconds if you want to record.
- [ ] Have the customer's Compendiq version, deployment shape, and known integration list in front of you (pull from their support ticket history or onboarding notes).
- [ ] Silence notifications. This is a human conversation, not a technical deep-dive.

---

## 1. Context (5 min)

Open with the customer's own words about their environment. Warm-up, not vendor talk.

- What does your team do? Who do you serve?
- Where did knowledge management fit before Compendiq? (Confluence only? Wiki + email? Slack search?)
- What triggered the decision to look for something new?

## 2. Problem framing (5 min)

The case study's "The problem" section lives or dies on this segment. Get the concrete pain.

- Walk me through a day-before-Compendiq story. What was the specific painful moment?
- If you had to put a number on "how much time did this cost us per week?" — even a rough one — what would you say?
- What was the tipping-point incident that made you actively shop?

## 3. Evaluation (5 min)

- What alternatives did you evaluate? (Expect: Glean, GitHub Copilot for Confluence, Atlassian Intelligence, home-grown.)
- What was the shortlist, and why?
- On a 1–10 scale, where were the rough edges of Compendiq in the evaluation phase? Be brutal — we use this to prioritise.

## 4. Deployment (5 min)

- What did the actual deployment look like? CE or EE? Single pod, multi-pod? On-prem, VPC, private cloud, SaaS?
- Which LLM stack did you pair with? (Ollama on the same host? Azure OpenAI? vLLM cluster?)
- What integrations did you turn on? (OIDC, SCIM, SMTP, audit retention, custom rate limits?)
- Time from "approved purchase" to "first production RAG query"?

## 5. Outcomes (5 min)

- What did the first month after rollout look like? Any surprises, positive or negative?
- Do you have a metric you can share? (Time to answer, adoption rate, support-ticket reduction, user NPS on internal tooling.) All numbers require customer approval in the review pass.
- Anything that broke or didn't work as expected?

## 6. Forward-looking (3 min)

- What's the single biggest open ask from Compendiq?
- Where does Compendiq fit in your roadmap over the next 12 months?
- If a peer customer in your industry asked you "should I use this?", what would you tell them?

## 7. Wrap (2 min)

- Is there anyone else on your team we should talk to for the technical-deep-dive side?
- Confirm the review process: we'll draft, send to you for a 10-business-day review, no response = approved.
- Confirm the revocation right: they can pull the case study at any time for any reason.

---

**After the call**

- [ ] Within 24h: send a thank-you email + the draft outline of the case study (not the full draft, just the section headers with 1-line summaries of what you'll put under each).
- [ ] Within 7 days: send the full draft for customer review.
- [ ] Mark the review SLA in your calendar so the 10-business-day clock doesn't silently expire.
- [ ] File the interview transcript in your private notes (not the repo).
