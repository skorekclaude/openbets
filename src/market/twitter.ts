/**
 * Twitter/X Verification — checks if a bot owner tweeted a verification code.
 * Uses Twitter API v2 (free tier: read-only, recent search).
 */

/**
 * Check if a user tweeted a specific verification code.
 * Returns true if a matching tweet is found from the given handle.
 *
 * Requires TWITTER_BEARER_TOKEN env var (free Developer tier).
 * Returns false (graceful degradation) if no token is configured.
 */
export async function checkTweetForCode(
  handle: string,
  code: string,
): Promise<{ found: boolean; error?: string }> {
  const token = process.env.TWITTER_BEARER_TOKEN;
  if (!token) {
    return {
      found: false,
      error: "Twitter verification not configured. Try email verification instead.",
    };
  }

  const cleanHandle = handle.replace(/^@/, "");
  // Search for exact code in recent tweets from this user
  const query = `from:${cleanHandle} "${code}"`;

  try {
    const res = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Twitter API] ${res.status}: ${text}`);
      if (res.status === 401) {
        return { found: false, error: "Twitter API authentication failed. Contact admin." };
      }
      if (res.status === 429) {
        return { found: false, error: "Twitter API rate limit reached. Try again in a few minutes." };
      }
      return { found: false, error: "Twitter API error. Try again later." };
    }

    const data = await res.json();
    const count = data.meta?.result_count ?? 0;
    return { found: count > 0 };
  } catch (e) {
    console.error("[Twitter API] Network error:", e);
    return { found: false, error: "Could not reach Twitter API. Try again later." };
  }
}

/**
 * Send a verification email with the code via Resend API.
 * Requires RESEND_API_KEY env var (free tier: 100 emails/day).
 */
export async function sendVerificationEmail(
  email: string,
  code: string,
): Promise<{ sent: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      sent: false,
      error: "Email verification not configured. Try X.com verification instead.",
    };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "OpenBets <noreply@openbets.bot>",
        to: email,
        subject: `Your OpenBets verification code: ${code}`,
        html: `
          <div style="font-family: monospace; background: #0a0a0a; color: #e0e0e0; padding: 32px; border-radius: 8px;">
            <h2 style="color: #4ade80; margin-top: 0;">OpenBets Verification</h2>
            <p>Your verification code:</p>
            <div style="background: #1a1a2e; border: 1px solid #4ade80; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
              <span style="font-size: 28px; letter-spacing: 4px; color: #4ade80; font-weight: bold;">${code}</span>
            </div>
            <p>Enter this code in the OpenBets dashboard to complete verification.</p>
            <p style="color: #666;">This code expires in 15 minutes.</p>
            <hr style="border-color: #333; margin: 24px 0;" />
            <p style="color: #555; font-size: 12px;">OpenBets — AI Agent Prediction Market</p>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Resend API] ${res.status}: ${text}`);
      if (res.status === 422) {
        return { sent: false, error: "Invalid email address." };
      }
      return { sent: false, error: "Failed to send verification email. Try again later." };
    }

    return { sent: true };
  } catch (e) {
    console.error("[Resend API] Network error:", e);
    return { sent: false, error: "Could not send email. Try again later." };
  }
}
