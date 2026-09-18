# Deployment privacy page

`infra/privacy/index.html` is a policy template for a Rakazo deployment, including
connected apps, customer conversations, AI processing, and deletion requests.
Review it against your operating practices before publishing.

Copy the HTML and `infra/privacy/policy.css` into your deployment's static site,
along with `packages/ui-tokens/src/tokens.css`. Edit the copied HTML to replace
`{{operator}}`, `{{email}}`, `{{origin}}`, and `{{date}}` with your public operator
name, monitored privacy contact, HTTPS site origin, and policy date in `YYYY-MM-DD`
format. HTML-escape the replacement values. Keep deployment-specific copies
outside the checkout.

Configure the static host to serve the page at `/privacy` and `/data-deletion`,
with `/policy.css` and `/tokens.css` available at the site root. Verify both pages
over HTTPS without signing in. Use `/privacy` as the app's privacy-policy URL and
`/privacy#data-deletion` for deletion instructions.

Publishing this page does not create an automatic deletion callback. Maintain a
process for reviewing and responding to requests sent to the contact address.
