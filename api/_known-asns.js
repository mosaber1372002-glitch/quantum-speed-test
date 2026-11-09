/*
 * Display names for AS numbers of well-known retail providers.
 *
 * Why this exists: registries name an AS with a short handle ("TE-AS", "LINKdotNET-AS"), which is correct but means nothing to a visitor.
 * How it is used (api/meta.js):
 *   - ONLY when the IP databases themselves report this AS number for the visitor's address. The visitor's AS number is never guessed.
 *   - The Network identifier row then reads "AS8452 · WE (Telecom Egypt)", with the registry's own name kept alongside it.
 *   - The Internet provider row takes the name from here only when no database named a usable retail ISP, and is labelled as coming
 *     from this list (medium confidence). It is never used when the address looks like a VPN, hosting or a business network.
 * `shared: true` marks a national or wholesale network: the name is shown as the NETWORK OPERATOR, but it is never assumed to be the visitor's
 * retail provider just because the address belongs to it (the Internet provider row then stays "not confirmed" unless a database names one).
 * Add or correct entries freely; one line per AS number. These entries were supplied by the site owner and are not verified online.
 * (AS36998 is Zain Sudan, not an Egyptian operator.)
 */
export const KNOWN_ASNS = {
  8452: { name: 'WE (Telecom Egypt)', shared: true },   // national network: its address space is not proof of which retail brand the visitor pays
  24835: { name: 'Vodafone Egypt' },
  36992: { name: 'Etisalat by e&' },
  36998: { name: 'Zain (formerly Sudanese Mobile Telephone)' },
  24863: { name: 'Link Egypt' }
};
