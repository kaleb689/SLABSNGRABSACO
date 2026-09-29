function normalizeAddressTokenText(
  value = ""
) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}


export function safeAddressVariants(
  address = {}
) {
  const street =
    normalizeAddressTokenText(
      address.address ||
      ""
    );

  const address2 =
    normalizeAddressTokenText(
      address.address2 ||
      ""
    );

  const city =
    normalizeAddressTokenText(
      address.city ||
      ""
    );

  const state =
    normalizeAddressTokenText(
      address.state ||
      ""
    );

  const zip =
    normalizeAddressTokenText(
      address.zip ||
      ""
    );

  const country =
    normalizeAddressTokenText(
      address.country ||
      ""
    );

  if (!street) {
    return [];
  }

  /*
    Safe JIG boundary:
    We only create truthful formatting variants of the exact address
    the customer supplied. Never change house number, unit number,
    city, state, ZIP, country, or the actual street-name words.

    USPS Publication 28 supports standardized directional/suffix/unit
    abbreviations and omission of nonessential punctuation. We use
    those formatting equivalences only.
  */
  const directionals = [
    ["NORTHWEST", "NW"],
    ["SOUTHWEST", "SW"],
    ["NORTHEAST", "NE"],
    ["SOUTHEAST", "SE"],
    ["NORTH", "N"],
    ["SOUTH", "S"],
    ["EAST", "E"],
    ["WEST", "W"]
  ];

  const suffixes = [
    ["ALLEY", "ALY"],
    ["ANNEX", "ANX"],
    ["ARCADE", "ARC"],
    ["AVENUE", "AVE"],
    ["BAYOU", "BYU"],
    ["BEACH", "BCH"],
    ["BEND", "BND"],
    ["BLUFF", "BLF"],
    ["BLUFFS", "BLFS"],
    ["BOTTOM", "BTM"],
    ["BOULEVARD", "BLVD"],
    ["BRANCH", "BR"],
    ["BRIDGE", "BRG"],
    ["BROOK", "BRK"],
    ["BROOKS", "BRKS"],
    ["BURG", "BG"],
    ["BURGS", "BGS"],
    ["BYPASS", "BYP"],
    ["CAMP", "CP"],
    ["CANYON", "CYN"],
    ["CAPE", "CPE"],
    ["CAUSEWAY", "CSWY"],
    ["CENTER", "CTR"],
    ["CENTERS", "CTRS"],
    ["CIRCLE", "CIR"],
    ["CIRCLES", "CIRS"],
    ["CLIFF", "CLF"],
    ["CLIFFS", "CLFS"],
    ["CLUB", "CLB"],
    ["COMMON", "CMN"],
    ["COMMONS", "CMNS"],
    ["CORNER", "COR"],
    ["CORNERS", "CORS"],
    ["COURSE", "CRSE"],
    ["COURT", "CT"],
    ["COURTS", "CTS"],
    ["COVE", "CV"],
    ["CREEK", "CRK"],
    ["CRESCENT", "CRES"],
    ["CREST", "CRST"],
    ["CROSSING", "XING"],
    ["CROSSROAD", "XRD"],
    ["CURVE", "CURV"],
    ["DALE", "DL"],
    ["DAM", "DM"],
    ["DIVIDE", "DV"],
    ["DRIVE", "DR"],
    ["DRIVES", "DRS"],
    ["ESTATE", "EST"],
    ["ESTATES", "ESTS"],
    ["EXPRESSWAY", "EXPY"],
    ["EXTENSION", "EXT"],
    ["EXTENSIONS", "EXTS"],
    ["FALLS", "FLS"],
    ["FERRY", "FRY"],
    ["FIELD", "FLD"],
    ["FIELDS", "FLDS"],
    ["FLAT", "FLT"],
    ["FLATS", "FLTS"],
    ["FORD", "FRD"],
    ["FORDS", "FRDS"],
    ["FOREST", "FRST"],
    ["FORGE", "FRG"],
    ["FORGES", "FRGS"],
    ["FORK", "FRK"],
    ["FORKS", "FRKS"],
    ["FORT", "FT"],
    ["FREEWAY", "FWY"],
    ["GARDEN", "GDN"],
    ["GARDENS", "GDNS"],
    ["GATEWAY", "GTWY"],
    ["GLEN", "GLN"],
    ["GLENS", "GLNS"],
    ["GREEN", "GRN"],
    ["GREENS", "GRNS"],
    ["GROVE", "GRV"],
    ["GROVES", "GRVS"],
    ["HARBOR", "HBR"],
    ["HARBORS", "HBRS"],
    ["HAVEN", "HVN"],
    ["HEIGHTS", "HTS"],
    ["HIGHWAY", "HWY"],
    ["HILL", "HL"],
    ["HILLS", "HLS"],
    ["HOLLOW", "HOLW"],
    ["INLET", "INLT"],
    ["ISLAND", "IS"],
    ["ISLANDS", "ISS"],
    ["JUNCTION", "JCT"],
    ["JUNCTIONS", "JCTS"],
    ["KEY", "KY"],
    ["KEYS", "KYS"],
    ["KNOLL", "KNL"],
    ["KNOLLS", "KNLS"],
    ["LAKE", "LK"],
    ["LAKES", "LKS"],
    ["LANDING", "LNDG"],
    ["LANE", "LN"],
    ["LIGHT", "LGT"],
    ["LIGHTS", "LGTS"],
    ["LOCK", "LCK"],
    ["LOCKS", "LCKS"],
    ["LODGE", "LDG"],
    ["MANOR", "MNR"],
    ["MANORS", "MNRS"],
    ["MEADOW", "MDW"],
    ["MEADOWS", "MDWS"],
    ["MILL", "ML"],
    ["MILLS", "MLS"],
    ["MISSION", "MSN"],
    ["MOTORWAY", "MTWY"],
    ["MOUNT", "MT"],
    ["MOUNTAIN", "MTN"],
    ["MOUNTAINS", "MTNS"],
    ["NECK", "NCK"],
    ["ORCHARD", "ORCH"],
    ["OVERPASS", "OPAS"],
    ["PARKWAY", "PKWY"],
    ["PASSAGE", "PSGE"],
    ["PINE", "PNE"],
    ["PINES", "PNES"],
    ["PLACE", "PL"],
    ["PLAIN", "PLN"],
    ["PLAINS", "PLNS"],
    ["PLAZA", "PLZ"],
    ["POINT", "PT"],
    ["POINTS", "PTS"],
    ["PORT", "PRT"],
    ["PORTS", "PRTS"],
    ["PRAIRIE", "PR"],
    ["RAPID", "RPD"],
    ["RAPIDS", "RPDS"],
    ["REST", "RST"],
    ["RIDGE", "RDG"],
    ["RIDGES", "RDGS"],
    ["RIVER", "RIV"],
    ["ROAD", "RD"],
    ["ROADS", "RDS"],
    ["ROUTE", "RTE"],
    ["SHOAL", "SHL"],
    ["SHOALS", "SHLS"],
    ["SHORE", "SHR"],
    ["SHORES", "SHRS"],
    ["SKYWAY", "SKWY"],
    ["SPRING", "SPG"],
    ["SPRINGS", "SPGS"],
    ["SQUARE", "SQ"],
    ["SQUARES", "SQS"],
    ["STATION", "STA"],
    ["STREAM", "STRM"],
    ["STREET", "ST"],
    ["STREETS", "STS"],
    ["SUMMIT", "SMT"],
    ["TERRACE", "TER"],
    ["THROUGHWAY", "TRWY"],
    ["TRACE", "TRCE"],
    ["TRACK", "TRAK"],
    ["TRAFFICWAY", "TRFY"],
    ["TRAIL", "TRL"],
    ["TRAILER", "TRLR"],
    ["TUNNEL", "TUNL"],
    ["TURNPIKE", "TPKE"],
    ["UNDERPASS", "UPAS"],
    ["UNION", "UN"],
    ["UNIONS", "UNS"],
    ["VALLEY", "VLY"],
    ["VALLEYS", "VLYS"],
    ["VIADUCT", "VIA"],
    ["VIEW", "VW"],
    ["VIEWS", "VWS"],
    ["VILLAGE", "VLG"],
    ["VILLAGES", "VLGS"],
    ["VILLE", "VL"],
    ["VISTA", "VIS"],
    ["WELL", "WL"],
    ["WELLS", "WLS"]
  ];

  const unitDesignators = [
    ["APARTMENT", "APT"],
    ["UNIT", "APT"],
    ["BUILDING", "BLDG"],
    ["FLOOR", "FL"],
    ["SUITE", "STE"],
    ["ROOM", "RM"],
    ["DEPARTMENT", "DEPT"]
  ];

  const streetVariants =
    new Set([
      street
    ]);

  const inlineUnit = !address2 && street.match(/^(.*\S)\s+(APT|APARTMENT|UNIT|SUITE|STE|#)\s*([A-Z0-9-]+)$/i);
  if (inlineUnit) streetVariants.add(inlineUnit[1].replace(/,\s*$/, ""));

  const addStreet =
    value => {
      const normalized =
        normalizeAddressTokenText(
          value
        );

      if (normalized) {
        streetVariants.add(
          normalized
        );
      }
    };

  /*
    Predirectional: immediately after the primary house number.
    Postdirectional: final token.
  */
  for (
    const [
      full,
      abbr
    ] of directionals
  ) {
    const escapedFull =
      full.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    const escapedAbbr =
      abbr.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    for (
      const base of
      Array.from(
        streetVariants
      )
    ) {
      addStreet(
        base.replace(
          new RegExp(
            `^(\\s*\\d+[A-Z0-9\\-/]*\\s+)${escapedFull}\\b`,
            "i"
          ),
          `$1${abbr}`
        )
      );

      addStreet(
        base.replace(
          new RegExp(
            `^(\\s*\\d+[A-Z0-9\\-/]*\\s+)${escapedAbbr}\\b`,
            "i"
          ),
          `$1${full}`
        )
      );

      addStreet(
        base.replace(
          new RegExp(
            `\\b${escapedFull}$`,
            "i"
          ),
          abbr
        )
      );

      addStreet(
        base.replace(
          new RegExp(
            `\\b${escapedAbbr}$`,
            "i"
          ),
          full
        )
      );
    }
  }

  /*
    Street suffix: only transform the final suffix token, or the token
    directly before a valid postdirectional. This avoids rewriting a
    street-name word that merely happens to look like a suffix.
  */
  for (
    const [
      full,
      abbr
    ] of suffixes
  ) {
    const fullPattern =
      full.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    const abbrPattern =
      abbr.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    const postDirectional =
      "(?:N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)";

    for (
      const base of
      Array.from(
        streetVariants
      )
    ) {
      addStreet(
        base.replace(
          new RegExp(
            `\\b${fullPattern}\\b(?=(?:\\s+${postDirectional})?$)`,
            "i"
          ),
          abbr
        )
      );

      addStreet(
        base.replace(
          new RegExp(
            `\\b${abbrPattern}\\b(?=(?:\\s+${postDirectional})?$)`,
            "i"
          ),
          full
        )
      );
    }
  }

  /*
    Keep punctuation that can be significant to delivery, including
    periods, slashes, hyphens, and apostrophes. Only omit a comma,
    which does not change the delivery-address components.
  */
  for (
    const base of
    Array.from(
      streetVariants
    )
  ) {
    addStreet(
      base.replace(
        /,/g,
        ""
      )
    );
  }

  for (const base of Array.from(streetVariants)) {
    if (/\bST$/i.test(base)) addStreet(`${base}.`);
    if (/\bST\.$/i.test(base)) addStreet(base.slice(0, -1));
  }

  // Only the street-name ordinal may change; the leading house number
  // never participates in this substitution.
  const cardinalOnes = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE"];
  const ordinalWords = ["", "FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH", "SIXTH", "SEVENTH", "EIGHTH", "NINTH"];
  const tensWords = ["", "TENTH", "TWENTIETH", "THIRTIETH", "FORTIETH", "FIFTIETH", "SIXTIETH", "SEVENTIETH", "EIGHTIETH", "NINETIETH"];
  const tens = ["", "TEN", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
  for (const base of Array.from(streetVariants)) {
    const match = base.match(/^(\d+[A-Z0-9\-/]*\s+(?:(?:N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)\s+)?)(\d{1,2})(ST|ND|RD|TH)\b/i);
    if (!match) continue;
    const value = Number(match[2]);
    if (value < 1 || value > 99) continue;
    let words = "";
    if (value <= 9) words = ordinalWords[value];
    else if (value === 10) words = "TENTH";
    else if (value < 20) words = ["ELEVENTH", "TWELFTH", "THIRTEENTH", "FOURTEENTH", "FIFTEENTH", "SIXTEENTH", "SEVENTEENTH", "EIGHTEENTH", "NINETEENTH"][value - 11];
    else words = value % 10 ? `${tens[Math.floor(value / 10)]}-${ordinalWords[value % 10]}` : tensWords[Math.floor(value / 10)];
    let cardinal = value < 10 ? cardinalOnes[value] : value === 10 ? "TEN" : value < 20
      ? ["ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"][value - 11]
      : `${tens[Math.floor(value / 10)]}${value % 10 ? "-" + cardinalOnes[value % 10] : ""}`;
    const ordinal = `${match[2]}${match[3]}`;
    addStreet(base.replace(new RegExp(`\\b${ordinal}\\b`, "i"), cardinal.toLowerCase()));
    addStreet(base.replace(new RegExp(`\\b${ordinal}\\b`, "i"), words.toLowerCase()));
    addStreet(base.replace(new RegExp(`\\b${ordinal}\\b`, "i"), match[2]));
  }

  const unitVariants =
    new Set([
      address2,
      ...(inlineUnit ? [`${inlineUnit[2]} ${inlineUnit[3]}`] : [])
    ]);

  const addUnit =
    value => {
      const normalized =
        normalizeAddressTokenText(
          value
        );

      unitVariants.add(
        normalized
      );
    };

  if (address2 || inlineUnit) {
    for (
      const [
        full,
        abbr
      ] of unitDesignators
    ) {
      const fullPattern =
        full.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

      const abbrPattern =
        abbr.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

      for (
        const base of
        Array.from(
          unitVariants
        )
      ) {
        addUnit(
          base.replace(
            new RegExp(
              `^${fullPattern}\\b`,
              "i"
            ),
            abbr
          )
        );

        addUnit(
          base.replace(
            new RegExp(
              `^${abbrPattern}\\b`,
              "i"
            ),
            full
          )
        );

        addUnit(
          base.replace(
            /,/g,
            ""
          )
        );
      }
    }
    const unitMatch = (address2 || `${inlineUnit[2]} ${inlineUnit[3]}`).match(/^(?:APT|APARTMENT|UNIT|SUITE|STE|#)\s*([A-Z0-9-]+)$/i);
    if (unitMatch) {
      for (const label of ["SUITE", "STE", "APT", "APARTMENT", "UNIT", "#"]) {
        addUnit(`${label === "#" ? "#" : `${label} `}${unitMatch[1]}`);
      }
    }
  }

  const seen =
    new Set();

  const variants =
    [];

  for (
    const variantStreet of
    streetVariants
  ) {
    for (
      const variantUnit of
      unitVariants
    ) {
      if (inlineUnit && variantStreet.includes(inlineUnit[2]) && variantUnit) continue;
      if (inlineUnit && !variantStreet.includes(inlineUnit[2]) && !variantUnit) continue;
      const item = {
        address:
          variantStreet,

        address2:
          variantUnit,

        city,

        state,

        zip,

        country
      };

      const key =
        JSON.stringify(
          item
        )
          .toUpperCase();

      if (
        seen.has(
          key
        )
      ) {
        continue;
      }

      seen.add(
        key
      );

      variants.push(
        item
      );

      if (
        variants.length >=
        120
      ) {
        return variants;
      }
    }
  }

  return variants;
}


export function safeAddressVariantKey(
  address = {}
) {
  return JSON.stringify({
    address:
      normalizeAddressTokenText(
        address.address ||
        ""
      ).toUpperCase(),

    address2:
      normalizeAddressTokenText(
        address.address2 ||
        ""
      ).toUpperCase(),

    city:
      normalizeAddressTokenText(
        address.city ||
        ""
      ).toUpperCase(),

    state:
      normalizeAddressTokenText(
        address.state ||
        ""
      ).toUpperCase(),

    zip:
      normalizeAddressTokenText(
        address.zip ||
        ""
      ).toUpperCase(),

    country:
      normalizeAddressTokenText(
        address.country ||
        ""
      ).toUpperCase()
  });
}


export function defaultJigVariants(original, limit = 4) {
  const mainKey = safeAddressVariantKey(original);
  const choices = safeAddressVariants(original).filter(item => safeAddressVariantKey(item) !== mainKey);
  const selected = [], streets = new Set();
  // Favor different street renderings before filling with unit-label variants.
  for (const item of choices) {
    const street = item.address.toUpperCase();
    if (streets.has(street)) continue;
    selected.push(item); streets.add(street);
    if (selected.length === limit) return selected;
  }
  for (const item of choices) {
    if (selected.some(saved => safeAddressVariantKey(saved) === safeAddressVariantKey(item))) continue;
    selected.push(item);
    if (selected.length === limit) break;
  }
  return selected;
}
