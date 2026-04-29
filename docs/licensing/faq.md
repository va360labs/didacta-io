# Licensing FAQ

> ⚠️ **DRAFT — under legal review.**

## Is Didacta open source?

No, not under the OSI definition. Didacta is **fair-code** and **source-available**. The source code is publicly visible and you can use it freely for internal business or non-commercial purposes, but distribution for a fee, paid hosting, white-label, and similar commercial uses require an agreement.

We adopt the same licensing model as [n8n.io](https://n8n.io).

## Can I use Didacta in my company?

Yes, for internal business purposes (training employees, internal LMS, internal documentation), without a commercial agreement.

## Can I use Didacta in my academy that charges students?

That qualifies as paid distribution / hosting on behalf of paying users. You need a commercial agreement or you can use Didacta Cloud.

## Can I host Didacta for clients?

Only if free of charge and for non-commercial purposes. If you are paid for hosting Didacta on behalf of someone else, you need a commercial agreement (Partner Program when launched, or direct license).

## Can I offer Didacta as SaaS?

Not without a written commercial agreement.

## Can I modify Didacta?

Yes, for any permitted use (internal business, non-commercial, evaluation, contribution). Modifications used in production must be marked as modified per the license. Distributing modifications for a fee is not permitted.

## Can I create plugins / modules / extensions?

Yes. Extensions you build on top of Didacta's public APIs and module contract are yours to keep. If you want to distribute them commercially, please coordinate with us first to ensure compliance with both the SUL and our trademark policy.

## Can I remove the Didacta logo / branding?

Not under the Community license. If you need white-label, that requires a commercial agreement (see `COMMERCIAL_USE.md`).

## What happens if my Enterprise license expires?

By default there is a 30-day grace period during which Enterprise features keep working with prominent warnings. After grace, Enterprise features are disabled — Community remains fully functional.

## Will Didacta become MIT/Apache one day?

The Sustainable Use License does NOT have an automatic Change Date (unlike BSL). We may decide voluntarily to relicense in the future, but it's not promised today. Any change would be announced via ADR with at least 90 days notice and would only apply to new versions.

## Is the License SDK code itself open source?

The License SDK (`packages/license-sdk/`) is part of Community and is licensed under the Sustainable Use License — you can read it, audit it, and even adapt it for your own use under the SUL terms. The Ed25519 public key is embedded; the private key lives only in our infrastructure.

## Can someone "crack" the License SDK?

Technically yes — anyone can modify open code. The real value of an Enterprise license is not the code: it's the support, security patches, certified compliance (Fundae, ISO), and integrations that come with it. Cracking the code does not give you any of that.

## Who is the licensor?

VA360 LABS S.L. (Spain), the company behind Didacta.
