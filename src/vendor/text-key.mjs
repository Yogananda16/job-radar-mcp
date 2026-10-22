// text-key.mjs: normalizeTextKey() from career-ops' tracker-parse.mjs (MIT, see
// LICENSE-career-ops), the one function the fingerprint and blacklist code use.

export function normalizeTextKey(value, separator = '') {
  // `value ?? ''` rather than String(value): a null/undefined cell must key to
  // '' like any other empty field, not to the literal strings "null"/"undefined"
  // — which would compare equal to each other and form a bogus group.
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    // Drop the combining dot that lowercasing a Turkish dotted capital leaves
    // behind. `'İ'.toLowerCase()` yields `i` + U+0307, not a plain `i`, so
    // `İstanbul Tekstil` and `Istanbul Tekstil` keyed differently while reading
    // identically on screen: the tracker treated one employer as two, and the
    // user had no way to see why (#2705, #2736, and verify-pipeline's duplicate
    // check, which returned a false green because of it).
    //
    // NO `NFD` here, and that is the whole safety property. NFKC leaves ż, ė
    // and ġ as SINGLE precomposed code points, so this strip cannot reach
    // their dots — while `i` + U+0307 has no precomposed form and stays
    // exposed. Decomposing first (NFD → strip → NFC) looks equivalent and is
    // not: it collapsed Żubr/Zubr, Ėmė/Eme and Ġenerali/Generali, which is
    // Polish, Lithuanian and Maltese losing the distinction (caught in main
    // by career-ops-ui, 12-ago). The protection is structural, not a list.
    .replace(/̇/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, separator)
    .trim();
}
