import { ContactKey } from './trigger-inputs';

/** Case- and punctuation-insensitive form of a header, so "Contact No." matches "contact no". */
export function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Header spellings accepted for each contact field, **most specific first** — the first alias that
 * matches a column in the sheet wins, so "Phone" beats "Alternate Phone" when a sheet has both.
 *
 * Deliberately omitted: a bare "Contact" and a bare "Number". Real sheets use "Contact" for either
 * the person or their phone, and guessing wrong silently dials the wrong column. An ambiguous
 * header is left for the user to map by hand, which the "auto mapped" count already signals.
 *
 * This is a stopgap. It is a static list because a static list is honest about what it does; a
 * fuzzy matcher that is right 90% of the time is worse here, since being wrong means calling
 * someone.
 */
export const CONTACT_HEADER_ALIASES: Readonly<Record<ContactKey, readonly string[]>> = {
  phone: [
    'phone',
    'phone number',
    'phone no',
    'contact phone',
    'contact number',
    'contact no',
    'contact mobile',
    'mobile',
    'mobile number',
    'mobile no',
    'msisdn',
    'telephone',
    'telephone number',
    'tel',
    'cell',
    'cell phone',
    'cell number',
    'whatsapp',
    'whatsapp number',
    'primary phone',
    'primary contact number',
    'alternate phone',
    'supplier phone',
    'supplier mobile',
    'customer phone',
    'customer mobile',
  ],
  name: [
    'name',
    'contact name',
    'contact person',
    'contact person name',
    'full name',
    'person name',
    'customer name',
    'supplier name',
    'vendor name',
    'first name',
  ],
  email: [
    'email',
    'e-mail',
    'email id',
    'email address',
    'contact email',
    'mail',
    'mail id',
    'supplier email',
    'customer email',
  ],
};

/**
 * Best-guess CSV column for each contact field the trigger still collects.
 *
 * A column is claimed at most once — with "Contact Name" and "Contact Number" both present, name
 * takes the first and phone the second rather than both grabbing whichever normalises alike.
 * Returns only the fields it is confident about; the rest stay blank for the user to map.
 */
export function matchContactHeaders(
  keys: readonly ContactKey[],
  headers: readonly string[]
): Partial<Record<ContactKey, string>> {
  const byNormalised = new Map<string, string>();
  for (const header of headers) {
    const key = normaliseHeader(header);
    // First occurrence wins, so a duplicate header can't displace the earlier column.
    if (key && !byNormalised.has(key)) byNormalised.set(key, header);
  }

  const matched: Partial<Record<ContactKey, string>> = {};
  const claimed = new Set<string>();

  for (const key of keys) {
    for (const alias of CONTACT_HEADER_ALIASES[key]) {
      const header = byNormalised.get(normaliseHeader(alias));
      if (header && !claimed.has(header)) {
        matched[key] = header;
        claimed.add(header);
        break;
      }
    }
  }
  return matched;
}
