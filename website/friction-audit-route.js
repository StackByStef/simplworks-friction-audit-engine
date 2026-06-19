/**
 * POST /api/friction-audit
 *
 * Accepts either a Friction Audit request or a Build request from the
 * Reach Me section. One endpoint, one table (friction_audit_requests),
 * discriminated by request_type = 'audit' | 'build'.
 *
 * Request body:
 *   {
 *     request_type: 'audit' | 'build'  (required)
 *     name: string                      (required)
 *     email?: string                    (email OR phone required)
 *     phone?: string                    (email OR phone required)
 *     website_url?: string              (required for audit, ignored for build)
 *     business_name?: string            (required for build, ignored for audit)
 *     project_description?: string      (optional for build, ignored for audit)
 *   }
 *
 * Response:
 *   200 { ok: true }
 *   400 { error: '...' }  - validation failure
 *   500 { error: '...' }  - database or email failure
 */

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

function contactMethod(email, phone) {
  if (email && phone) return 'both';
  if (email) return 'email';
  if (phone) return 'phone';
  return 'none';
}

function subjectFor(requestType, method, subject) {
  const label = requestType === 'build' ? 'BUILD' : 'WALK-THROUGH';
  const methodLabel = method === 'both' ? 'both' : method;
  return `NEW ${label} REQUEST (${methodLabel}): ${subject}`;
}

async function sendNotification(payload) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing; skipping email notification.');
    return;
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { request_type, name, email, phone, website_url, business_name, project_description } = payload;

  const method = contactMethod(email, phone);
  const subjectSource =
    request_type === 'build' ? business_name : website_url;
  const subject = subjectFor(request_type, method, subjectSource);

  const projectDescriptionSection =
    request_type === 'build' && project_description
      ? `\nProject description:\n${project_description}\n`
      : '';

  const body = `
${request_type === 'build' ? 'NEW BUILD REQUEST' : 'NEW WALK-THROUGH REQUEST'} from simplworks.ai

Name: ${name}
Email: ${email || 'Not provided'}
Phone: ${phone || 'Not provided'}
${request_type === 'audit' ? `Website URL: ${website_url}` : `Business: ${business_name}`}
Request type: ${request_type}
Received: ${new Date().toISOString()}
${projectDescriptionSection}
${email ? `Reply to the prospect at: ${email}` : ''}
  `.trim();

  try {
    await resend.emails.send({
      from: 'SimplWorks <onboarding@resend.dev>',
      to: ['you@yourdomain.com', 'team@yourdomain.com'],
      replyTo: email || undefined,
      subject,
      text: body,
    });
  } catch (err) {
    console.error('Resend notification failed:', err);
  }
}

/**
 * Fires the SimplWorks Friction Audit Engine (n8n) for an audit request.
 * Fire-and-forget: the prospect's form response does not wait on this.
 * The engine scrapes + scores their site and emails them the branded PDF,
 * and posts the lead (name/email/phone) to Slack for follow-up.
 */
async function triggerAuditEngine({ name, email, phone, website_url }) {
  const webhookUrl = process.env.N8N_AUDIT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('N8N_AUDIT_WEBHOOK_URL missing; skipping audit engine trigger.');
    return;
  }
  // Shared-secret header so the n8n webhook only accepts calls from this site.
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.N8N_AUDIT_WEBHOOK_SECRET) {
    headers['x-audit-secret'] = process.env.N8N_AUDIT_WEBHOOK_SECRET;
  }
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: website_url, email, name, phone }),
    });
  } catch (err) {
    console.error('Audit engine trigger failed:', err);
  }
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeUrl(raw) {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return 'https://' + trimmed;
  return trimmed;
}

export async function POST(request) {
  try {
    const body = await request.json();
    const {
      request_type,
      name,
      email: rawEmail,
      phone: rawPhone,
      website_url: rawUrl,
      business_name: rawBiz,
      project_description: rawDesc,
    } = body || {};

    if (request_type !== 'audit' && request_type !== 'build') {
      return Response.json(
        { error: 'Invalid request type.' },
        { status: 400 }
      );
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return Response.json(
        { error: 'Name is required.' },
        { status: 400 }
      );
    }

    const email = rawEmail && typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : null;
    const phone = rawPhone && typeof rawPhone === 'string' ? rawPhone.trim() : null;

    if (email && !isValidEmail(email)) {
      return Response.json(
        { error: 'That email address looks off. Double-check and try again.' },
        { status: 400 }
      );
    }

    if (!email && !phone) {
      return Response.json(
        {
          error:
            "One way or the other. Email or phone. Can't reach you with nothing.",
        },
        { status: 400 }
      );
    }

    let website_url = null;
    let business_name = null;
    let project_description = null;

    if (request_type === 'audit') {
      if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
        return Response.json(
          { error: 'Your website is required.' },
          { status: 400 }
        );
      }
      website_url = normalizeUrl(rawUrl);
    } else {
      if (!rawBiz || typeof rawBiz !== 'string' || rawBiz.trim().length === 0) {
        return Response.json(
          { error: 'Your business name is required.' },
          { status: 400 }
        );
      }
      business_name = rawBiz.trim();
      if (rawDesc && typeof rawDesc === 'string' && rawDesc.trim().length > 0) {
        project_description = rawDesc.trim();
      }
    }

    const supabase = getSupabase();
    const { error: dbError } = await supabase
      .from('friction_audit_requests')
      .insert({
        name: name.trim(),
        email,
        phone,
        website_url,
        business_name,
        project_description,
        request_type,
      });

    if (dbError) {
      console.error('Supabase insert error:', dbError);
      return Response.json(
        {
          error:
            "Something went wrong on my end. Email me at you@yourdomain.com and we'll pick it up from there.",
        },
        { status: 500 }
      );
    }

    // IMPORTANT: await these. On Vercel's serverless functions, un-awaited
    // background work is killed the instant the response returns, so
    // fire-and-forget silently drops the notification AND the audit trigger.
    // Both helpers swallow their own errors, so awaiting can't fail the form.
    // The webhook replies 202 immediately (the audit runs async in n8n), so
    // the form stays fast.
    const tasks = [
      sendNotification({
        request_type,
        name: name.trim(),
        email,
        phone,
        website_url,
        business_name,
        project_description,
      }),
    ];

    // Audit requests also trigger the Friction Audit Engine (n8n) so the
    // prospect receives the scored, branded PDF automatically.
    if (request_type === 'audit') {
      tasks.push(
        triggerAuditEngine({
          name: name.trim(),
          email,
          phone,
          website_url,
        })
      );
    }

    await Promise.all(tasks);

    return Response.json({ ok: true });
  } catch (err) {
    console.error('friction-audit route error:', err);
    return Response.json(
      {
        error:
          "Something went wrong on my end. Email me at you@yourdomain.com and we'll pick it up from there.",
      },
      { status: 500 }
    );
  }
}
