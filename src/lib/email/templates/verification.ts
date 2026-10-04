import { escapeHtml, safeUrl } from "../escape";

export function verificationEmailTemplate({
  name,
  url,
}: {
  name?: string | null;
  url: string;
}) {
  const displayName = escapeHtml(name ?? "there");
  const href = safeUrl(url);

  return `
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email verification</title>
  <!--[if (gte mso 9)|(IE)]>
  <style type="text/css">
    table { border-collapse: collapse; }
    .outlook-fix { width:600px; }
  </style>
  <![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap');
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; }
      .email-padding { padding-left: 24px !important; padding-right: 24px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#11100F;">
  <!--[if (gte mso 9)|(IE)]>
  <table width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr><td>
  <![endif]-->
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color:#11100F; border-collapse:collapse;">
    <tr><td height="40" style="font-size:0; line-height:0;">&nbsp;</td></tr>
    <tr>
      <td align="center">
        <table role="presentation" class="email-container" align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px; width:100%; background-color:#201F1E; border-radius:16px; border-collapse:collapse; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;" bgcolor="#201F1E">
          <tr>
            <td class="email-padding" style="padding:44px 36px 0 36px; background-color:#201F1E;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr>
                  <td style="width:22px; height:22px; background-color:#D7D1B0; border-radius:6px;" bgcolor="#D7D1B0">&nbsp;</td>
                  <td style="width:10px; font-size:0; line-height:0;">&nbsp;</td>
                  <td style="font-size:18px; font-weight:700; color:#FFFFFF; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">Kinéo</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="line-height:32px; font-size:0;" height="32">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px;">
              <h1 style="font-size:24px; font-weight:600; color:#FFFFFF; margin:0; padding:0; line-height:1.4; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">Welcome to Kinéo!</h1>
            </td>
          </tr>
          <tr><td style="line-height:28px; font-size:0;" height="28">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px;">
              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr><td style="border-top:1px solid #33312D; font-size:0; line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>
          <tr><td style="line-height:32px; font-size:0;" height="32">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px; color:#D9D6D0; font-size:16px; line-height:1.7; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">
              <p style="padding:0; margin:0;">Bonjour <strong style="color:#FFFFFF;">${displayName}</strong>,</p>
            </td>
          </tr>
          <tr><td style="line-height:18px; font-size:0;" height="18">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px; color:#D9D6D0; font-size:16px; line-height:1.7; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">
              <p style="padding:0; margin:0;">Thank you for creating an account. To use the service we have to confirm that this email address really belongs to you.</p>
            </td>
          </tr>
          <tr><td style="line-height:18px; font-size:0;" height="18">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px; color:#D9D6D0; font-size:16px; line-height:1.7; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">
              <p style="padding:0; margin:0;">Click the button below to validate your address:</p>
            </td>
          </tr>
          <tr><td style="line-height:34px; font-size:0;" height="34">&nbsp;</td></tr>
          <tr>
            <td align="center" style="padding:0 36px;">
              <table align="center" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr>
                  <td align="center" style="background-color:#D7D1B0; padding:15px 34px; border-radius:999px;" bgcolor="#D7D1B0">
                    <a href="${href}" style="color:#11100F; font-weight:600; font-size:16px; text-decoration:none; display:inline-block; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">Verify my email</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="line-height:34px; font-size:0;" height="34">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px; font-size:14px; line-height:1.6; color:#8A8680; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">
              <p style="padding:0; margin:0;">This link is valid for 24 hours.</p>
            </td>
          </tr>
          <tr><td style="line-height:10px; font-size:0;" height="10">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px; font-size:14px; line-height:1.6; color:#8A8680; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">
              <p style="padding:0; margin:0;">If you did not create an account, ignore this email.</p>
            </td>
          </tr>
          <tr><td style="line-height:10px; font-size:0;" height="10">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px; font-size:14px; line-height:1.6; color:#8A8680; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">
              <p style="padding:0; margin:0;">We are glad to have you with us!</p>
            </td>
          </tr>
          <tr><td style="line-height:40px; font-size:0;" height="40">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px;">
              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr><td style="border-top:1px solid #33312D; font-size:0; line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>
          <tr><td style="line-height:22px; font-size:0;" height="22">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px;">
              <p style="padding:0; margin:0; font-size:13px; color:#8A8680; text-align:center; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">© ${new Date().getFullYear()} Kinéo. All rights reserved.</p>
            </td>
          </tr>
          <tr><td style="line-height:8px; font-size:0;" height="8">&nbsp;</td></tr>
          <tr>
            <td class="email-padding" style="padding:0 36px 40px 36px;">
              <p style="padding:0; margin:0; font-size:13px; color:#8A8680; text-align:center; font-family:'Space Grotesk', Arial, Helvetica, sans-serif;">This email was sent automatically, please do not reply.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr><td height="40" style="font-size:0; line-height:0;">&nbsp;</td></tr>
  </table>
  <!--[if (gte mso 9)|(IE)]>
  </td></tr></table>
  <![endif]-->
</body>
</html>
  `;
}
