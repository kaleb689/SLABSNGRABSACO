const PLANS = {
  1: { name: "Starter", profiles: 1, amount: 10 },
  2: { name: "Intermediate", profiles: 2, amount: 15 },
  3: { name: "Advanced", profiles: 3, amount: 25 },
  4: { name: "Pro", profiles: 5, amount: 45 },
  5: { name: "High Volume", profiles: 10, amount: 70 },
  6: { name: "Power User", profiles: 20, amount: 100 },
  7: { name: "Elite", profiles: 50, amount: 215 }
};

const RENTAL_PRICING = {
  5: { "1_drop": 10, "1_week": 25, "1_month": 60 },
  10: { "1_drop": 20, "1_week": 50, "1_month": 120 },
  15: { "1_drop": 30, "1_week": 75, "1_month": 180 }
};

const ADMIN_PREVIEW_PARAMS =
  new URLSearchParams(
    window.location.search
  );

const ADMIN_PREVIEW_MODE =
  ADMIN_PREVIEW_PARAMS.get(
    "adminPreview"
  ) === "1";

const SUCCESS_DEMO_MODE = ADMIN_PREVIEW_PARAMS.get("successDemo") === "1";

const ADMIN_PREVIEW_TIER =
  Math.min(
    7,
    Math.max(
      1,
      Number(
        localStorage.getItem(
          "sng_admin_test_tier"
        ) ||
        ADMIN_PREVIEW_PARAMS.get(
          "adminPreviewTier"
        ) ||
        4
      ) || 4
    )
  );

const ADMIN_TEST_RENTALS_KEY =
  "sng_admin_test_rentals";

const ADMIN_TEST_TIER_KEY =
  "sng_admin_test_tier";


function adminTestReadRentals() {
  try {
    const parsed =
      JSON.parse(
        localStorage.getItem(
          ADMIN_TEST_RENTALS_KEY
        ) ||
        "[]"
      );

    return Array.isArray(parsed)
      ? parsed
      : [];

  } catch {
    return [];
  }
}


function adminTestSaveRentals(
  rentals
) {
  localStorage.setItem(
    ADMIN_TEST_RENTALS_KEY,
    JSON.stringify(
      Array.isArray(rentals)
        ? rentals
        : []
    )
  );
}


function adminTestExpiration(
  durationType,
  from = new Date()
) {
  const date =
    new Date(
      from.getTime()
    );

  if (
    durationType ===
    "1_drop"
  ) {
    date.setDate(
      date.getDate() + 1
    );
  } else if (
    durationType ===
    "1_week"
  ) {
    date.setDate(
      date.getDate() + 7
    );
  } else {
    const originalDay =
      date.getDate();

    date.setDate(1);

    date.setMonth(
      date.getMonth() + 1
    );

    const lastDay =
      new Date(
        date.getFullYear(),
        date.getMonth() + 1,
        0
      ).getDate();

    date.setDate(
      Math.min(
        originalDay,
        lastDay
      )
    );
  }

  return date.toISOString();
}


function adminTestDurationLabel(
  durationType
) {
  if (
    durationType ===
    "1_week"
  ) {
    return "1 WEEK";
  }

  if (
    durationType ===
    "1_month"
  ) {
    return "1 MONTH";
  }

  return "1 DROP";
}


function adminTestDaysRemaining(
  expiresAt
) {
  const remaining =
    new Date(
      expiresAt
    ).getTime() -
    Date.now();

  return Math.max(
    0,
    Math.ceil(
      remaining /
      86400000
    )
  );
}

const savedTier = Number(
  localStorage.getItem("sng_selected_tier")
);

const state = {
  tier:
    PLANS[savedTier]
      ? savedTier
      : null,

  customer: null,

  membership: null,

  upgradeMode: false,

  orders: [],

  profileLoaded: false,

  retailerProfiles: [],

specialProfiles: [],

freeMemberships: [],

rentedMemberships: [],

rentalCart: null,

managedAvailability: null,

retailerAllowance: 0,

retailerProfilesLoaded: false,

savedDetails: {
  addresses: [],
  paymentMethods: []
},

accountStats: {
  userSince: null,
  displayName: "Member",
  ogMember: false,
  lifetimeSpend: 0,
  totalOrders: 0
}
};

try {
  const savedRentalCart =
    JSON.parse(
      localStorage.getItem(
        "sng_rental_cart"
      ) || "null"
    );

  if (savedRentalCart) {
    state.rentalCart =
      savedRentalCart;
  }
} catch {
  localStorage.removeItem(
    "sng_rental_cart"
  );
}

/* =====================================================
   HELPERS
===================================================== */

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    character =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[character]
  );
}


function formatDate(value) {
  if (!value) return "â€”";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleDateString(
    undefined,
    {
      year: "numeric",
      month: "long",
      day: "numeric"
    }
  );
}


function calculateDaysRemaining(value) {
  if (!value) return "â€”";

  const end = new Date(value);

  if (Number.isNaN(end.getTime())) {
    return "â€”";
  }

  const difference =
    end.getTime() - Date.now();

  return Math.max(
    0,
    Math.ceil(
      difference /
      (1000 * 60 * 60 * 24)
    )
  );
}


async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}


function setButtonBusy(
  button,
  busy,
  busyText = "Workingâ€¦"
) {
  if (!button) return;

  if (busy) {
    if (!button.dataset.originalText) {
      button.dataset.originalText =
        button.textContent;
    }

    button.disabled = true;
    button.textContent = busyText;
    return;
  }

  button.disabled = false;

  if (button.dataset.originalText) {
    button.textContent =
      button.dataset.originalText;

    delete button.dataset.originalText;
  }
}


function setMessage(
  element,
  message = "",
  type = ""
) {
  if (!element) return;

  element.textContent = message;

  element.classList.remove(
    "success",
    "error",
    "info"
  );

  if (type) {
    element.classList.add(type);
  }

  element.hidden = !message;
}


function showAccountMessage(
  message,
  type = "info"
) {
  const element =
    document.getElementById(
      "account-message"
    );

  setMessage(
    element,
    message,
    type
  );
}


function clearAccountMessage() {
  showAccountMessage("");
}


function normalizeStatus(status) {
  if (!status) return "Unknown";

  return String(status)
    .replace(/_/g, " ")
    .replace(/\b\w/g, character =>
      character.toUpperCase()
    );
}


function getOrderNumber(order) {
  return (
    order?.orderNumber ||
    order?.submissionNumber ||
    order?.id ||
    ""
  );
}


function getOrderProfile(order) {
  return (
    order?.profile ||
    order?.customer ||
    {}
  );
}


function getMembershipSource(data) {
  if (!data) return {};

  return (
    data.membership ||
    data.subscription ||
    data
  );
}


/* =====================================================
   PAGE NAVIGATION
===================================================== */

const VALID_PAGES = [
  "home",
  "pricing",
  "profile",
  "guide",
  "my-profile"
];


function go(page) {
  const target =
    document.getElementById(page);

  if (!target) return;

  document
    .querySelectorAll(".page")
    .forEach(section => {
      section.classList.remove(
        "active"
      );
    });

  target.classList.add("active");

  document
    .querySelectorAll(
      ".nav-link[data-page]"
    )
    .forEach(link => {
      link.classList.toggle(
        "active",
        link.dataset.page === page
      );
    });

  if (
    location.hash !==
    `#${page}`
  ) {
    history.replaceState(
      null,
      "",
      `#${page}`
    );
  }

  if (page === "my-profile") {
    loadMemberProfile();
  }

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}


document
  .querySelectorAll("[data-page]")
  .forEach(element => {
    element.addEventListener(
      "click",
      event => {
        event.preventDefault();

        closeCart();

        go(
          element.dataset.page
        );
      }
    );
  });


window.addEventListener(
  "hashchange",
  () => {
    const page =
      location.hash.slice(1);

    if (
      VALID_PAGES.includes(page)
    ) {
      go(page);
    }
  }
);


/* =====================================================
   PRICING CARDS
===================================================== */

function pricingCardsHtml() {
  return Object.entries(PLANS)
    .map(([tier, plan]) => {
      const tierNumber =
        Number(tier);

      const featured =
        tierNumber === 4;

      const profileWord =
        plan.profiles === 1
          ? "Profile"
          : "Profiles";

      return `
        <article
          class="plan ${
            featured
              ? "featured"
              : ""
          }"
          data-tier="${tier}"
        >

          ${
            featured
              ? `
                <span class="popular">
                  POPULAR
                </span>
              `
              : ""
          }

          <span class="plan-name">
            ${escapeHtml(plan.name)}
          </span>

          <div class="plan-price">
            $${plan.amount}
            <small>/month</small>
          </div>

          <h3>
            ${plan.profiles}
            ACO ${profileWord}
          </h3>

          <p class="plan-description">
            ${plan.profiles}
            ${
              plan.profiles === 1
                ? "profile"
                : "profiles"
            }
            at each supported retailer.
          </p>

          <ul class="features">

            <li>
              ${plan.profiles}
              ${
                plan.profiles === 1
                  ? "profile"
                  : "profiles"
              }
              at each retailer
            </li>

            <li>
              Target, Walmart,
              Sam's Club, Costco
              &amp; PKC
            </li>

            <li>
              Profile submission portal
            </li>

            <li>
              Discord community access
            </li>

            <li>
              Community support
            </li>

          </ul>

          <button
            type="button"
            class="primary full"
            data-select="${tier}"
          >
            Select Tier
          </button>

        </article>
      `;
    })
    .join("");
}


function renderPricing() {
  const pricingGrid =
    document.getElementById(
      "pricing-grid"
    );

  const homePricingGrid =
    document.getElementById(
      "home-pricing-grid"
    );

  const cards =
    pricingCardsHtml();

  if (pricingGrid) {
    pricingGrid.innerHTML =
      cards;
  }

  if (homePricingGrid) {
    homePricingGrid.innerHTML =
      cards;
  }

  bindTierButtons();
  initializeMembershipCarousel();
}


/* =====================================================
   HOME MEMBERSHIP CAROUSEL
===================================================== */

function initializeMembershipCarousel() {
  const track =
    document.getElementById(
      "home-pricing-grid"
    );

  const viewport =
    track?.parentElement;

  const previousButton =
    document.getElementById(
      "membership-carousel-previous"
    );

  const nextButton =
    document.getElementById(
      "membership-carousel-next"
    );

  const dotsContainer =
    document.getElementById(
      "membership-carousel-dots"
    );

  if (
    !track ||
    !viewport ||
    !previousButton ||
    !nextButton ||
    !dotsContainer
  ) {
    return;
  }

  let currentIndex = 0;


  function getVisibleCards() {
    if (window.innerWidth <= 700) {
      return 1;
    }

    if (window.innerWidth <= 1050) {
      return 2;
    }

    return 3;
  }


  function getCards() {
    return Array.from(
      track.querySelectorAll(".plan")
    );
  }


  function getMaxIndex() {
    return Math.max(
      0,
      getCards().length -
        getVisibleCards()
    );
  }


  function createDots() {
    const maxIndex =
      getMaxIndex();

    dotsContainer.innerHTML = "";

    for (
      let index = 0;
      index <= maxIndex;
      index += 1
    ) {
      const dot =
        document.createElement(
          "button"
        );

      dot.type = "button";

      dot.className =
        "membership-carousel-dot";

      dot.setAttribute(
        "aria-label",
        `Show membership group ${
          index + 1
        }`
      );

      dot.addEventListener(
        "click",
        () => {
          currentIndex = index;

          updateCarousel();
        }
      );

      dotsContainer.appendChild(
        dot
      );
    }
  }


  function updateCarousel() {
    const cards = getCards();

    if (!cards.length) {
      return;
    }

    const maxIndex =
      getMaxIndex();

    currentIndex = Math.min(
      Math.max(
        currentIndex,
        0
      ),
      maxIndex
    );

    /*
     * Use the card's ACTUAL position
     * inside the track.
     *
     * This avoids all width/gap
     * calculation errors.
     */
    const targetCard =
      cards[currentIndex];

    const movement =
      targetCard.offsetLeft -
      cards[0].offsetLeft;

    track.style.transform =
      `translate3d(-${movement}px, 0, 0)`;


    previousButton.disabled =
      currentIndex === 0;

    nextButton.disabled =
      currentIndex === maxIndex;


    const dots = Array.from(
      dotsContainer.querySelectorAll(
        ".membership-carousel-dot"
      )
    );

    dots.forEach(
      (dot, index) => {
        const active =
          index === currentIndex;

        dot.classList.toggle(
          "active",
          active
        );

        dot.setAttribute(
          "aria-current",
          active
            ? "true"
            : "false"
        );
      }
    );
  }


  previousButton.onclick = () => {
    if (currentIndex === 0) {
      return;
    }

    currentIndex -= 1;

    updateCarousel();
  };


  nextButton.onclick = () => {
    const maxIndex =
      getMaxIndex();

    if (
      currentIndex >= maxIndex
    ) {
      return;
    }

    currentIndex += 1;

    updateCarousel();
  };


  /*
   * Always start:
   *
   * Starter
   * Pro (Popular)
   * Advanced
   */
  currentIndex = 0;

  createDots();

  requestAnimationFrame(
    () => {
      track.style.transform =
        "translate3d(0, 0, 0)";

      updateCarousel();
    }
  );


  let resizeTimer;

  window.addEventListener(
    "resize",
    () => {
      clearTimeout(
        resizeTimer
      );

      resizeTimer =
        setTimeout(
          () => {
            currentIndex =
              Math.min(
                currentIndex,
                getMaxIndex()
              );

            createDots();

            updateCarousel();
          },
          100
        );
    }
  );
}


/* =====================================================
   PLAN SELECTION
===================================================== */

function updatePricingUpgradeButtons() {
  const currentTier =
    Number(
      state.membership?.tier ||
      0
    );

  if (ADMIN_PREVIEW_MODE && targetPlan) {
    state.membership = {
      ...(state.membership || {}),
      tier,
      planName: targetPlan.name,
      amount: targetPlan.amount,
      profiles: targetPlan.profiles,
      status: "active"
    };
    state.retailerAllowance = targetPlan.profiles;

    localStorage.setItem(
      ADMIN_TEST_TIER_KEY,
      String(tier)
    );

    renderMembership(state.membership);
    renderRetailerProfiles();
    updatePricingUpgradeButtons();
    showAccountMessage(
      `Preview switched to ${targetPlan.name}. No Stripe charge was created.`,
      "success"
    );
    return;
  }

  document
    .querySelectorAll(
      "[data-select]"
    )
    .forEach(button => {
      const tier =
        Number(
          button.dataset.select
        );

      if (!PLANS[tier]) {
        return;
      }

      button.disabled =
        false;

      button.textContent =
        "Select Tier";

      if (
        !state.upgradeMode ||
        !currentTier
      ) {
        return;
      }

      if (
        tier <
        currentTier
      ) {
        button.disabled =
          true;

        button.textContent =
          "Lower Tier";

        return;
      }

      if (
        tier ===
        currentTier
      ) {
        button.disabled =
          true;

        button.textContent =
          "Current Tier";

        return;
      }

      button.textContent =
        "Upgrade";
    });
}


function bindTierButtons() {
  document
    .querySelectorAll(
      "[data-select]"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        async () => {
          await selectTier(
            Number(
              button.dataset.select
            )
          );
        }
      );
    });

  updatePricingUpgradeButtons();
}


async function selectTier(
  tier
) {
  if (!PLANS[tier]) {
    return;
  }

  if (
    state.upgradeMode
  ) {
    await upgradeMembershipToTier(
      tier
    );

    return;
  }

  state.tier =
    tier;

  localStorage.setItem(
    "sng_selected_tier",
    String(tier)
  );

  updateSelectedPlan();
  updateCart();
  openCart();
}


/* =========================================6Ú±î¸Â¸­yêë¢°k¢G§¦*^ÓÓÓÓÓÓÓÓÓÓÓĞ¢4TÄT5DTBÄà£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦gVæ7F–öâWFFU6VÆV7FVEÆâ‚’°¢6öç7B6VÆV7FVBĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'6VÆV7FVB×Æâ ¢“° ¢–b‚6VÆV7FVB’&WGW&ã° ¢–b€¢7FFRçF–W"ÇÀ¢Äå5·7FFRçF–W%Ğ¢’°¢6VÆV7FVBçFW‡D6öçFVçBĞ¢$6†ö÷6RÖVÖ&W'6†—f—'7B#° ¢&WGW&ã°¢Ğ ¢6öç7BÆâĞ¢Äå5·7FFRçF–W%Ó° ¢6VÆV7FVBçFW‡D6öçFVçBĞ¢G·ÆâææÖWÒ(	BBG·ÆâæÖ÷VçGÒöÖöçF†°§Ğ  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢4%@£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ¦gVæ7F–öâ6ÆV%6VÆV7FVEF–W"‚’° ¢7FFRçF–W"ÒçVÆÃ° ¢Æö6Å7F÷&vRç&VÖ÷fT—FVÒ€¢'6æu÷6VÆV7FVE÷F–W" ¢“° ¢WFFU6VÆV7FVEÆâ‚“°¢WFFT6'B‚“°§Ğ  ¦gVæ7F–öâ6ÆV%&VçFÄ6'D—FVÒ‚’°¢7FFRç&VçFÄ6'BĞ¢çVÆÃ° ¢Æö6Å7F÷&vRç&VÖ÷fT—FVÒ€¢'6æu÷&VçFÅö6'B ¢“° ¢WFFT6'B‚“°§Ğ  ¦gVæ7F–öâWFFT6'B‚’°¢6öç7B6÷VçBĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&6'BÖ6÷VçB ¢“° ¢6öç7B6öçFVçBĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&6'BÖ6öçFVçB ¢“° ¢6öç7B6ÆV$'WGFöâĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&6ÆV"Ö6'B ¢“° ¢6öç7BÆâĞ¢7FFRçF–W ¢òÄå5·7FFRçF–W%Ğ¢¢çVÆÃ° ¢6öç7B&VçFÂĞ¢7FFRç&VçFÄ6'C° ¢6öç7B—FVÔ6÷VçBĞ¢‡Æâò¢’°¢‡&VçFÂò¢“° ¢–b‚—FVÔ6÷VçB’°¢–b†6÷VçB’°¢6÷VçBçFW‡D6öçFVçBÒ##°¢Ğ ¢–b†6ÆV$'WGFöâ’°¢6ÆV$'WGFöâæ†–FFVâÒG'VS°¢Ğ ¢–b†6öçFVçB’°¢6öçFVçBæ–ææW$…DÔÂÒ ¢ÆF—b6Æ73Ò&V×G’Ö6'B#à¢Çå–÷W"6'B—2V×G’ãÂ÷à¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'&–Ö'’gVÆÂ ¢–CÒ&V×G’Ö6'B×&–6–ær ¢à¢f–WrÖVÖ&W'6†—0¢Âö'WGFöãà¢ÂöF—cà¢° ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&V×G’Ö6'B×&–6–ær ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6Æ÷6T6'B‚“°¢vò‚'&–6–ær"“°¢Ğ¢“°¢Ğ ¢&WGW&ã°¢Ğ ¢–b†6÷VçB’°¢6÷VçBçFW‡D6öçFVçBĞ¢7G&–ær†—FVÔ6÷VçB“°¢Ğ ¢–b†6ÆV$'WGFöâ’°¢6ÆV$'WGFöâæ†–FFVâÒfÇ6S°¢Ğ ¢–b‚6öçFVçB’&WGW&ã° ¢6öç7B'G2ÒµÓ° ¢–b‡Æâ’°¢'G2çW6‚† ¢ÆF—b6Æ73Ò&6'BÖ—FVÒ#à¢ÆF—b6Æ73Ò&6'BÖ—FVÒ×F÷Æ–æR#à¢Ç7â6Æ73Ò'ÆâÖæÖR#à¢G¶W66T‡FÖÂ‡ÆâææÖR—Ğ¢Â÷7ãà ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò&6'BÖ—FVÒ×&VÖ÷fR ¢–CÒ'&VÖ÷fRÖÖVÖ&W'6†—Ö6'BÖ—FVÒ ¢&–ÖÆ&VÃÒ%&VÖ÷fRÖVÖ&W'6†—g&öÒ6'B ¢à¢&VÖ÷fP¢Âö'WGFöãà¢ÂöF—cà ¢Ç7G&öæsà¢BG·ÆâæÖ÷VçGÒöÖöçF€¢Â÷7G&öæsà ¢Çà¢G·Æâç&öf–ÆW7Ğ¢G°¢Æâç&öf–ÆW2ÓÓÒ¢ò$4ò&öf–ÆR ¢¢$4ò&öf–ÆW2 ¢Ğ¢W"7W÷'FVB&WF–ÆW"à¢Â÷à¢ÂöF—cà ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'&–Ö'’gVÆÂ ¢–CÒ&6'BÖ6†V6¶÷WB ¢à¢6öçF–çVRÖVÖ&W'6†—6†V6¶÷WB(i ¢Âö'WGFöãà¢“°¢Ğ ¢–b‡&VçFÂ’°¢6öç7B&WF–ÆW$Æ&VÂĞ¢&VçFÂç&WF–ÆW"ÓÓÒ'vÆÖ'B ¢ò%vÆÖ'B ¢¢%F&vWB#° ¢6öç7BGW&F–öäÆ&VÂĞ¢&VçFÂæGW&F–öåG—RÓÓÒ#÷vVV² ¢ò#vVV² ¢¢&VçFÂæGW&F–öåG—RÓÓÒ#öÖöçF‚ ¢ò#ÖöçF‚ ¢¢#G&÷#° ¢'G2çW6‚† ¢ÆF—b6Æ73Ò&6'BÖ—FVÒ&VçFÂÖ6'BÖ—FVÒ#à¢ÆF—b6Æ73Ò&6'BÖ—FVÒ×F÷Æ–æR#à¢Ç7â6Æ73Ò'ÆâÖæÖR#à¢G¶W66T‡FÖÂ‡&WF–ÆW$Æ&VÂ—Ò66÷VçB&VçFÀ¢Â÷7ãà ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò&6'BÖ—FVÒ×&VÖ÷fR ¢–CÒ'&VÖ÷fR×&VçFÂÖ6'BÖ—FVÒ ¢&–ÖÆ&VÃÒ%&VÖ÷fR&VçFÂg&öÒ6'B ¢à¢&VÖ÷fP¢Âö'WGFöãà¢ÂöF—cà ¢Ç7G&öæsà¢BG¶W66T‡FÖÂ‡&VçFÂç&–6R—Ğ¢Â÷7G&öæsà ¢Çà¢G¶W66T‡FÖÂ‡&VçFÂçVçF—G’—Ò66÷VçG2(
 ¢G¶W66T‡FÖÂ†GW&F–öäÆ&VÂ—Ğ¢Â÷à¢ÂöF—cà ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'&–Ö'’gVÆÂ ¢–CÒ'&VçFÂÖ6'BÖ6†V6¶÷WB ¢à¢6†V6¶÷WB&VçFÂ(i ¢Âö'WGFöãà¢“°¢Ğ ¢6öçFVçBæ–ææW$…DÔÂĞ¢'G2æ¦ö–â‚""“° ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'&VÖ÷fRÖÖVÖ&W'6†—Ö6'BÖ—FVÒ ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6ÆV%6VÆV7FVEF–W"‚“°¢Ğ¢“° ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'&VÖ÷fR×&VçFÂÖ6'BÖ—FVÒ ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6ÆV%&VçFÄ6'D—FVÒ‚“°¢Ğ¢“° ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&6'BÖ6†V6¶÷WB ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6Æ÷6T6'B‚“°¢vò‚'&öf–ÆR"“°¢Ğ¢“° ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'&VçFÂÖ6'BÖ6†V6¶÷WB ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢6†V6¶÷WE&VçFÄ6'@¢“°§Ğ   ¦gVæ7F–öâ&VçFÅ&–6R€¢VçF—G’À¢GW&F–öåG—P¢’°¢&WGW&â€¢$TåDÅõ$”4”äsòå·VçF—G•Ğ¢òå¶GW&F–öåG—UÒóòçVÆÀ¢“°§Ğ ¦gVæ7F–öâWFFU&VçFÅ&–6TF—7Æ’‚’°¢6öç7B&WF–ÆW"Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&VçFÂ×&WF–ÆW" ¢“òçfÇVRÇÂ'F&vWB#° ¢6öç7BVçF—G’Ğ¢çVÖ&W"€¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&VçFÂÖ66÷VçB×VçF—G’ ¢“òçfÇVRÇÂP¢“° ¢6öç7BGW&F–öåG—RĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&VçFÂÖGW&F–öâ ¢“òçfÇVRÇÂ#öG&÷#° ¢6öç7B&–6RĞ¢&VçFÅ&–6R€¢VçF—G’À¢GW&F–öåG—P¢“° ¢6öç7BF—7Æ’Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&VçFÂÖWFò×&–6R ¢“° ¢–b†F—7Æ’’°¢F—7Æ’çFW‡D6öçFVçBĞ¢&–6RÓÒçVÆÀ¢ò.(	B ¢¢BG·&–6WÖ°¢Ğ ¢6öç7Bf–Æ&ÆRĞ¢çVÖ&W"€¢7FFRæÖævVDf–Æ&–Æ—G¢òå·&WF–ÆW%Ğ¢òæf–Æ&ÆRÇÂ ¢“° ¢6öç7BFD'WGFöâĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&VçFÂÖFB×FòÖ6'B ¢“° ¢–b†FD'WGFöâ’°¢6öç7BÖVÖ&W'6†—ÆÆ÷vVBĞ¢†47F—fU–DÖVÖ&W'6†—‚“° ¢FD'WGFöâæF—6&ÆVBĞ¢ÖVÖ&W'6†—ÆÆ÷vVBÇÀ¢&–6RÓÒçVÆÂÇÀ¢f–Æ&ÆRÂVçF—G“° ¢FD'WGFöâçFW‡D6öçFVçBĞ¢ÖVÖ&W'6†—ÆÆ÷vV@¢ò$ÖVÖ&W'6†—&WV—&VB ¢¢€¢f–Æ&ÆRÂVçF—G¢ò$æ÷BVæ÷Vv‚66÷VçG2 ¢¢$FBFò6'B ¢“°¢Ğ§Ğ ¦gVæ7F–öâFE&VçFÅFô6'B‚’°¢–b€¢†47F—fU–DÖVÖ&W'6†—‚¢’°¢6†÷t66÷VçDÖW76vR€¢$â7F—fR–B÷"v–gFVBÖVÖ&W'6†——2&WV—&VB&Vf÷&R–÷R6â&VçBFF—F–öæÂ66÷VçG2â"À¢&W'&÷" ¢“° ¢vò€¢'&–6–ær ¢“° ¢&WGW&ã°¢Ğ ¢6öç7B&WF–ÆW"Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&VçFÂ×&WF–ÆW" ¢“òçfÇVRÇÂ'F&vWB#° ¢6öç7BVçF—G’Ğ¢çVÖ&W"€¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&VçFÂÖ66÷VçB×VçF—G’ ¢“òçfÇVRÇÂP¢“° ¢6öç7BGW&F–öåG—RĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&VçFÂÖGW&F–öâ ¢“òçfÇVRÇÂ#öG&÷#° ¢6öç7B&–6RĞ¢&VçFÅ&–6R€¢VçF—G’À¢GW&F–öåG—P¢“° ¢6öç7Bf–Æ&ÆRĞ¢çVÖ&W"€¢7FFRæÖævVDf–Æ&–Æ—G¢òå·&WF–ÆW%Ğ¢òæf–Æ&ÆRÇÂ ¢“° ¢–b€¢&–6RÓÒçVÆÂÇÀ¢f–Æ&ÆRÂVçF—G¢’°¢6†÷t66÷VçDÖW76vR€¢%F†W&R&Ræ÷BVæ÷Vv‚66÷VçG2f–Æ&ÆRf÷"F†B&VçFÂ6¶vRâ"À¢&W'&÷" ¢“°¢&WGW&ã°¢Ğ ¢7FFRç&VçFÄ6'BÒ°¢&WF–ÆW"À¢VçF—G’À¢GW&F–öåG—RÀ¢&–6P¢Ó° ¢Æö6Å7F÷&vRç6WD—FVÒ€¢'6æu÷&VçFÅö6'B"À¢¥4ôâç7G&–æv–g’€¢7FFRç&VçFÄ6'@¢¢“° ¢WFFT6'B‚“°¢÷Vä6'B‚“°§Ğ ¦7–æ2gVæ7F–öâ6†V6¶÷WE&VçFÄ6'B‚’°¢6öç7B&VçFÂĞ¢7FFRç&VçFÄ6'C° ¢–b‚&VçFÂ’&WGW&ã° ¢–b€¢†47F—fU–DÖVÖ&W'6†—‚¢’°¢7FFRç&VçFÄ6'BĞ¢çVÆÃ° ¢Æö6Å7F÷&vRç&VÖ÷fT—FVÒ€¢'6æu÷&VçFÅö6'B ¢“° ¢WFFT6'B‚“° ¢6†÷t66÷VçDÖW76vR€¢$â7F—fR–B÷"v–gFVBÖVÖ&W'6†——2&WV—&VB&Vf÷&R–÷R6âW&6†6R&VçFÂ6¶vRâ"À¢&W'&÷" ¢“° ¢vò€¢'&–6–ær ¢“° ¢&WGW&ã°¢Ğ ¢–b„DÔ”åõ$Ud”UuôÔôDR’°¢6öç7Bæ÷rĞ¢æWrFFR‚“° ¢6öç7B7F'G4BĞ¢æ÷rçFô•4õ7G&–ær‚“° ¢6öç7BW‡—&W4BĞ¢FÖ–åFW7DW‡—&F–öâ€¢&VçFÂæGW&F–öåG—RÀ¢æ÷p¢“° ¢6öç7B&WF–ÆW$Æ&VÂĞ¢&VçFÂç&WF–ÆW"ÓÓĞ¢'vÆÖ'B ¢ò%vÆÖ'B ¢¢%F&vWB#° ¢6öç7BW†—7F–ærĞ¢FÖ–åFW7E&VE&VçFÇ2‚“° ¢6öç7B6–×VÆFVBĞ¢µÓ° ¢f÷"€¢ÆWB–æFW‚Ò°¢–æFW‚À¢çVÖ&W"€¢&VçFÂçVçF—G’ÇÀ¢ ¢“°¢–æFW‚³Ò¢’°¢6öç7B76–væÖVçD–BĞ¢DÔ”âÕDU5BÒG´FFRææ÷r‚—ÒÒG¶–æFW‚²Ö° ¢6–×VÆFVBçW6‚‡°¢76–væÖVçD–BÀ¢&öf–ÆUG—S ¢'&VçFVB"À¢&VçFVDÖVÖ&W'6†—–C ¢76–væÖVçD–BÀ¢ÖævVD66÷VçD–C ¢76–væÖVçD–BÀ¢&WF–ÆW# ¢&VçFÂç&WF–ÆW"À¢&WF–ÆW$Æ&VÂÀ¢GW&F–öåG—S ¢&VçFÂæGW&F–öåG—RÀ¢GW&F–öäÆ&VÃ ¢FÖ–åFW7DGW&F–öäÆ&VÂ€¢&VçFÂæGW&F–öåG—P¢’À¢7F'G4BÀ¢W‡—&W4BÀ¢F—5&VÖ–æ–æs ¢FÖ–åFW7DF—5&VÖ–æ–ær€¢W‡—&W4@¢’À¢7F—fS ¢G'VRÀ¢7W7FöÖW%&öf–ÆS¢°¢&öf–ÆTæÖS ¢$FÖ–âFW7B7W7FöÖW""À¢f—'7DæÖS ¢$FÖ–â"À¢Æ7DæÖS ¢%FW7B7W7FöÖW""À¢VÖ–Ã ¢&FÖ–â×FW7D6Æ'6æw&'66òæ6öÒ"À¢†öæS ¢""À¢FG&W73 ¢""À¢FG&W73# ¢""À¢6—G“ ¢""À¢7FFS ¢""À¢¦— ¢""À¢6÷VçG'“ ¢%U2 ¢ÒÀ¢7W7FöÖW$6&C ¢çVÆÂÀ¢FW7DöæÇ“ ¢G'VP¢Ò“°¢Ğ ¢6öç7BWFFVBÒ°¢ââæW†—7F–ærÀ¢ââç6–×VÆFV@¢Ó° ¢FÖ–åFW7E6fU&VçFÇ2€¢WFFV@¢“° ¢7FFRç&VçFVDÖVÖ&W'6†—2Ğ¢WFFVC° ¢7FFRç&VçFÄ6'BĞ¢çVÆÃ° ¢Æö6Å7F÷&vRç&VÖ÷fT—FVÒ€¢'6æu÷&VçFÅö6'B ¢“° ¢WFFT6'B‚“° ¢&VæFW%&WF–ÆW%&öf–ÆW2‚“° ¢6†÷t66÷VçDÖW76vR€¢DU5B$TåDÂ4ôÕÄUDS¢G·6–×VÆFVBæÆVæwF‡ÒG·&WF–ÆW$Æ&VÇÒ66÷VçBG°¢6–×VÆFVBæÆVæwF‚ÓÓÒ¢ò" ¢¢'2 ¢ÒFFVBv—F†÷WB–ÖVçBâæò7G&—R6†&vR÷"&VÂ–çfVçF÷'’v2W6VBæÀ¢'7V66W72 ¢“° ¢6Æ÷6T6'B‚“° ¢Fö7VÖVç@¢çVW'•6VÆV7F÷"€¢u¶FFÖ66÷VçB×F#Ò&VF—B×&öf–ÆR%Òp¢¢òæ6Æ–6²‚“° ¢&WGW&ã°¢Ğ ¢6öç7B'WGFöâĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&VçFÂÖ6'BÖ6†V6¶÷WB ¢“° ¢6WD'WGFöä'W7’€¢'WGFöâÀ¢G'VRÀ¢$÷Væ–ær7G&—^(
b ¢“° ¢G'’°¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö7&VFR×&VçFÂÖ6†V6¶÷WB×6W76–öâ"À¢°¢ÖWF†öC¢%õ5B"À¢7&VFVçF–Ç3¢'6ÖRÖ÷&–v–â"À¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡°¢&WF–ÆW# ¢&VçFÂç&WF–ÆW"À¢VçF—G“ ¢&VçFÂçVçF—G’À¢GW&F–öåG—S ¢&VçFÂæGW&F–öåG—P¢Ò¢Ğ¢“° ¢6öç7BFFĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢FFæW'&÷"ÇÀ¢%Væ&ÆRFò7F'B&VçFÂ6†V6¶÷WBâ ¢“°¢Ğ ¢v–æF÷ræÆö6F–öâæ‡&VbĞ¢FFçW&Ã° ¢Ò6F6‚†W'&÷"’°¢ÆW'B†W'&÷"æÖW76vR“°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢fÇ6P¢“°¢Ğ§Ğ ¦gVæ7F–öâ7Fö6´ÆWfVÄ6Æ72€¢f–Æ&ÆRÀ¢F÷FÀ¢’°¢6öç7B6fTf–Æ&ÆRĞ¢çVÖ&W"†f–Æ&ÆRÇÂ“° ¢6öç7B6fUF÷FÂĞ¢ÖF‚æÖ‚€¢À¢çVÖ&W"‡F÷FÂÇÂ¢“° ¢6öç7B&F–òĞ¢6fTf–Æ&ÆRò6fUF÷FÃ° ¢–b‡6fTf–Æ&ÆRÃÒÇÂ&F–òÃÒã#’°¢&WGW&â°¢6Æ74æÖS¢'7Fö6²×&VB"À¢Æ&VÃ¢6fTf–Æ&ÆRÃÒ ¢ò$õUBôb5Dô4² ¢¢$Äõr5Dô4² ¢Ó°¢Ğ ¢–b‡&F–òÃÒãS’°¢&WGW&â°¢6Æ74æÖS¢'7Fö6²×–VÆÆ÷r"À¢Æ&VÃ¢$Ä”Ô•DTB ¢Ó°¢Ğ ¢&WGW&â°¢6Æ74æÖS¢'7Fö6²Öw&VVâ"À¢Æ&VÃ¢$”â5Dô4² ¢Ó°§Ğ ¦gVæ7F–öâWFFU&VçFÅ7Fö6´6&B€¢&WF–ÆW"À¢FF¢’°¢6öç7B6&BĞ¢Fö7VÖVçBçVW'•6VÆV7F÷"€¢¶FF×&VçFÂ×7Fö6²Ö6&CÒ"G·&WF–ÆW'Ò%Ö ¢“° ¢6öç7B7FGW2Ğ¢Fö7VÖVçBçVW'•6VÆV7F÷"€¢¶FF×&VçFÂ×7Fö6²×7FGW3Ò"G·&WF–ÆW'Ò%Ö ¢“° ¢–b‚6&BÇÂ7FGW2’&WGW&ã° ¢6öç7B7Fö6²Ğ¢7Fö6´ÆWfVÄ6Æ72€¢FFòæf–Æ&ÆRÀ¢FFòçF÷FÀ¢“° ¢6&Bæ6Æ74Æ—7Bç&VÖ÷fR€¢'7Fö6²Öw&VVâ"À¢'7Fö6²×–VÆÆ÷r"À¢'7Fö6²×&VB ¢“° ¢6&Bæ6Æ74Æ—7BæFB€¢7Fö6²æ6Æ74æÖP¢“° ¢7FGW2çFW‡D6öçFVçBĞ¢7Fö6²æÆ&VÃ°§Ğ ¦gVæ7F–öâ÷Vä6'B‚’°¢6öç7BG&vW"Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&6'BÖG&vW" ¢“° ¢6öç7B&6¶G&÷Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&6'BÖ&6¶G&÷ ¢“° ¢–b‚G&vW"ÇÂ&6¶G&÷’°¢&WGW&ã°¢Ğ ¢G&vW"æ6Æ74Æ—7BæFB‚&÷Vâ"“°¢&6¶G&÷æ6Æ74Æ—7BæFB‚&÷Vâ"“° ¢G&vW"ç6WDGG&–'WFR€¢&&–Ö†–FFVâ"À¢&fÇ6R ¢“°§Ğ  ¦gVæ7F–öâ6Æ÷6T6'B‚’°¢6öç7BG&vW"Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&6'BÖG&vW" ¢“° ¢6öç7B&6¶G&÷Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&6'BÖ&6¶G&÷ ¢“° ¢–b‚G&vW"ÇÂ&6¶G&÷’°¢&WGW&ã°¢Ğ ¢G&vW"æ6Æ74Æ—7Bç&VÖ÷fR‚&÷Vâ"“°¢&6¶G&÷æ6Æ74Æ—7Bç&VÖ÷fR‚&÷Vâ"“° ¢G&vW"ç6WDGG&–'WFR€¢&&–Ö†–FFVâ"À¢'G'VR ¢“°§Ğ  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B‚&6'BÖ'WGFöâ"¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢÷Vä6'@¢“°  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B‚&6'BÖ6Æ÷6R"¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢6Æ÷6T6'@¢“°  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&6'BÖ&6¶G&÷ ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢6Æ÷6T6'@¢“°  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&6'B×f–Wr×F–W'2 ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6Æ÷6T6'B‚“°¢vò‚'&–6–ær"“°¢Ğ¢“°  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&6ÆV"Ö6'B ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6ÆV%6VÆV7FVEF–W"‚“°¢7FFRç&VçFÄ6'BÒçVÆÃ°¢Æö6Å7F÷&vRç&VÖ÷fT—FVÒ€¢'6æu÷&VçFÅö6'B ¢“°¢WFFT6'B‚“°¢Ğ¢“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢tUB5D%DTBdõ$Ğ£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦6öç7B&öf–ÆTf÷&ÒĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&öf–ÆRÖf÷&Ò ¢“°  ¦6öç7B$ôd”ÄUôd”TÄEôÄ$TÅ2Ò°¢&öf–ÆTæÖS ¢%&öf–ÆRæÖR"À¢f—'7DæÖS ¢$f—'7BæÖR"À¢Æ7DæÖS ¢$Æ7BæÖR"À¢VÖ–Ã ¢$VÖ–Â"À¢†öæS ¢%†öæR"À¢FG&W73 ¢$FG&W72"À¢6÷VçG'“ ¢$6÷VçG'’"À¢7FFS ¢%7FFR"À¢6—G“ ¢$6—G’"À¢¦— ¢%¦—6öFR"À¢6ôVÖ–Ã ¢$”Ôò†÷7BVÖ–Â"À¢6õ77v÷&C ¢$”Ôò†÷7B77v÷&B"À¢6&DÆ&VÃ ¢$6&BÆ&VÂ"À¢6&F†öÆFW# ¢$6&F†öÆFW"æÖR"À¢6ô6&DçVÖ&W# ¢$6&BçVÖ&W""À¢W‡ÖöçFƒ ¢$W‡âÖöçF‚"À¢W‡–V# ¢$W‡â–V""À¢6V7W&—G”6öFS ¢%6V7W&—G’6öFR"À¢6öæf—&Ó ¢$–æf÷&ÖF–öâ6öæf—&ÖF–öâ §Ó°  ¦gVæ7F–öâ&öf–ÆTf–VÆDW'&÷$ÖW76vR€¢f–VÆ@¢’°¢6öç7BæÖRĞ¢f–VÆCòææÖRÇÂ"#° ¢6öç7BÆ&VÂĞ¢$ôd”ÄUôd”TÄEôÄ$TÅ5¶æÖUÒÇÀ¢%F†—2f–VÆB#° ¢6öç7B&ufÇVRĞ¢f–VÆCòçG—RÓÓÒ&6†V6¶&÷‚ ¢ò€¢f–VÆBæ6†V6¶V@¢ò&6†V6¶VB ¢¢" ¢¢¢7G&–ær€¢f–VÆCòçfÇVRÇÀ¢" ¢’çG&–Ò‚“° ¢–b€¢f–VÆCòç&WV—&VBb`¢&ufÇVP¢’°¢–b€¢f–VÆBçG—RÓÓĞ¢&6†V6¶&÷‚ ¢’°¢&WGW&â€¢%ÆV6R6öæf—&ÒF†BF†R–æf÷&ÖF–öâ&÷fR—267W&FRâ ¢“°¢Ğ ¢&WGW&â€¢G¶Æ&VÇÒ—2&WV—&VBæ ¢“°¢Ğ ¢–b€¢æÖRÓÓÒ&VÖ–Â"ÇÀ¢æÖRÓÓÒ&6ôVÖ–Â ¢’°¢–b€¢õåµåÇ4Ò´µåÇ4ÒµÂåµåÇ4Ò²BòçFW7B€¢&ufÇVP¢¢’°¢&WGW&â€¢VçFW"fÆ–BG¶Æ&VÂçFôÆ÷vW$66R‚—Òæ ¢“°¢Ğ¢Ğ ¢–b€¢æÖRÓÓÒ&6õ77v÷&B"b`¢&ufÇVRæÆVæwF‚Â`¢’°¢&WGW&â€¢$”Ôò†÷7B77v÷&B×W7B&RBÆV7Bb6†&7FW'2â ¢“°¢Ğ ¢–b€¢æÖRÓÓĞ¢&6ô6&DçVÖ&W" ¢’°¢6öç7BF–v—G2Ğ¢&ufÇVRç&WÆ6R€¢õÄBörÀ¢" ¢“° ¢–b€¢õåÆG³"Ã—ÒBòçFW7B€¢F–v—G0¢¢’°¢&WGW&â€¢$VçFW"fÆ–B6&BçVÖ&W"W6–ær.(	3’F–v—G2â ¢“°¢Ğ¢Ğ ¢–b€¢æÖRÓÓĞ¢'6V7W&—G”6öFR"b`¢õåÆG³2ÃGÒBòçFW7B€¢&ufÇVP¢¢’°¢&WGW&â€¢%6V7W&—G’6öFR×W7B&R2÷"BF–v—G2â ¢“°¢Ğ ¢–b€¢æÖRÓÓÒ&W‡ÖöçF‚"b`¢õâƒ³Ó•×Ã³Ó%Ò’BòçFW7B€¢&ufÇVP¢¢’°¢&WGW&â€¢%6VÆV7BfÆ–BW‡—&F–öâÖöçF‚â ¢“°¢Ğ ¢–b€¢æÖRÓÓÒ&W‡–V""b`¢õåÆG³GÒBòçFW7B€¢&ufÇVP¢¢’°¢&WGW&â€¢%6VÆV7BfÆ–BW‡—&F–öâ–V"â ¢“°¢Ğ ¢–b€¢€¢æÖRÓÓÒ&W‡ÖöçF‚"ÇÀ¢æÖRÓÓÒ&W‡–V" ¢¢’°¢6öç7BÖöçF„f–VÆBĞ¢&öf–ÆTf÷&ÓòæVÆVÖVçG0¢òææÖVD—FVÒ€¢&W‡ÖöçF‚ ¢“° ¢6öç7B–V$f–VÆBĞ¢&öf–ÆTf÷&ÓòæVÆVÖVçG0¢òææÖVD—FVÒ€¢&W‡–V" ¢“° ¢6öç7BÖöçF‚Ğ¢çVÖ&W"€¢ÖöçF„f–VÆCòçfÇVP¢“° ¢6öç7B–V"Ğ¢çVÖ&W"€¢–V$f–VÆCòçfÇVP¢“° ¢–b€¢ÖöçF‚b`¢–V ¢’°¢6öç7Bæ÷rĞ¢æWrFFR‚“° ¢6öç7B7W'&VçDÖöçF‚Ğ¢æ÷rævWDÖöçF‚‚’²° ¢6öç7B7W'&VçE–V"Ğ¢æ÷rævWDgVÆÅ–V"‚“° ¢–b€¢–V"Â7W'&VçE–V"ÇÀ¢€¢–V"ÓÓÒ7W'&VçE–V"b`¢ÖöçF‚Â7W'&VçDÖöçF€¢¢’°¢&WGW&â€¢%F†R6&BW‡—&F–öâFFR†2Ç&VG’76VBâ ¢“°¢Ğ¢Ğ¢Ğ ¢–b€¢f–VÆCòçG—RÓÓÒ&VÖ–Â"b`¢f–VÆBçfÆ–F—G’çfÆ–@¢’°¢&WGW&â€¢VçFW"fÆ–BG¶Æ&VÂçFôÆ÷vW$66R‚—Òæ ¢“°¢Ğ ¢–b€¢f–VÆCòçfÆ–F—G“òçfÆ–@¢’°¢&WGW&â€¢G¶Æ&VÇÒ—2–æ6÷'&V7Bæ ¢“°¢Ğ ¢&WGW&â"#°§Ğ  ¦gVæ7F–öâ6ÆV%&öf–ÆTf–VÆDW'&÷"€¢f–VÆ@¢’°¢–b‚f–VÆB’&WGW&ã° ¢f–VÆBæ6Æ74Æ—7Bç&VÖ÷fR€¢'&öf–ÆRÖf–VÆBÖ–çfÆ–B ¢“° ¢f–VÆBç&VÖ÷fTGG&–'WFR€¢&&–Ö–çfÆ–B ¢“° ¢6öç7BÆ&VÂĞ¢f–VÆBæ6Æ÷6W7B€¢&Æ&VÂ ¢“° ¢Æ&VÃòæ6Æ74Æ—7Bç&VÖ÷fR€¢&†2×&öf–ÆRÖW'&÷" ¢“° ¢6öç7BW'&÷"Ğ¢Æ&VÃòçVW'•6VÆV7F÷"€¢"ç&öf–ÆRÖf–VÆBÖW'&÷" ¢“° ¢W'&÷#òç&VÖ÷fR‚“°§Ğ  ¦gVæ7F–öâ6†÷u&öf–ÆTf–VÆDW'&÷"€¢f–VÆBÀ¢W'&÷$ÖW76vP¢’°¢–b€¢f–VÆBÇÀ¢W'&÷$ÖW76vP¢’°¢&WGW&ã°¢Ğ ¡¶¬{®0®+^zºè¬è‘ééŠ—  clearProfileFieldError(
    field
  );

  field.classList.add(
    "profile-field-invalid"
  );

  field.setAttribute(
    "aria-invalid",
    "true"
  );

  const label =
    field.closest(
      "label"
    );

  label?.classList.add(
    "has-profile-error"
  );

  if (!label) return;

  const error =
    document.createElement(
      "small"
    );

  error.className =
    "profile-field-error";

  error.textContent =
    errorMessage;

  label.appendChild(
    error
  );
}


function validateCreateProfileForm(
  form,
  {
    focusFirst = true
  } = {}
) {
  const fields =
    Array.from(
      form.querySelectorAll(
        "input[name], select[name]"
      )
    );

  fields.forEach(
    clearProfileFieldError
  );

  const invalid =
    [];

  fields.forEach(field => {
    const errorMessage =
      profileFieldErrorMessage(
        field
      );

    if (
      !errorMessage
    ) {
      return;
    }

    invalid.push({
      field,
      name:
        PROFILE_FIELD_LABELS[
          field.name
        ] ||
        field.name,
      errorMessage
    });

    showProfileFieldError(
      field,
      errorMessage
    );
  });

  /*
    Expiration is a paired value. If one side makes
    the date expired, clearly mark both selectors.
  */
  const expirationError =
    invalid.find(item =>
      (
        item.field.name ===
          "expMonth" ||
        item.field.name ===
          "expYear"
      ) &&
      item.errorMessage.includes(
        "already passed"
      )
    );

  if (expirationError) {
    [
      "expMonth",
      "expYear"
    ].forEach(name => {
      const field =
        form.elements.namedItem(
          name
        );

      if (
        field &&
        !invalid.some(
          item =>
            item.field === field
        )
      ) {
        invalid.push({
          field,
          name:
            PROFILE_FIELD_LABELS[
              name
            ],
          errorMessage:
            expirationError
              .errorMessage
        });

        showProfileFieldError(
          field,
          expirationError
            .errorMessage
        );
      }
    });
  }

  const message =
    document.getElementById(
      "form-message"
    );

  if (
    invalid.length
  ) {
    const uniqueNames =
      [
        ...new Set(
          invalid.map(
            item =>
              item.name
          )
        )
      ];

    if (message) {
      message.classList.add(
        "profile-validation-summary"
      );

      message.textContent =
        `Please fix ${uniqueNames.length} ${
          uniqueNames.length === 1
            ? "field"
            : "fields"
        }: ${uniqueNames.join(", ")}.`;
    }

    if (focusFirst) {
      const firstField =
        invalid[0].field;

      firstField
        .scrollIntoView({
          behavior:
            "smooth",
          block:
            "center"
        });

      window.setTimeout(
        () => {
          try {
            firstField.focus({
              preventScroll:
                true
            });
          } catch {
            firstField.focus();
          }
        },
        250
      );
    }

    return false;
  }

  if (message) {
    message.classList.remove(
      "profile-validation-summary"
    );

    message.textContent =
      "";
  }

  return true;
}


profileForm
  ?.querySelectorAll(
    "input[name], select[name]"
  )
  .forEach(field => {
    const eventName =
      (
        field.tagName ===
          "SELECT" ||
        field.type ===
          "checkbox"
      )
        ? "change"
        : "input";

    field.addEventListener(
      eventName,
      () => {
        clearProfileFieldError(
          field
        );

        /*
          Re-check the expiration pair together so
          an expired date clears as soon as corrected.
        */
        if (
          field.name ===
            "expMonth" ||
          field.name ===
            "expYear"
        ) {
          const monthField =
            profileForm.elements
              .namedItem(
                "expMonth"
              );

          const yearField =
            profileForm.elements
              .namedItem(
                "expYear"
              );

          [
            monthField,
            yearField
          ].forEach(
            clearProfileFieldError
          );
        }
      }
    );
  });


profileForm?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const form =
      event.currentTarget;

    const message =
      document.getElementById(
        "form-message"
      );

    if (
      !state.tier ||
      !PLANS[state.tier]
    ) {
      if (message) {
        message.textContent =
          "Please choose a membership tier first.";
      }

      go("pricing");
      return;
    }

    if (
      !validateCreateProfileForm(
        form
      )
    ) {
      return;
    }

    const formData =
      new FormData(form);

    const all =
      Object.fromEntries(
        formData.entries()
      );

    const secretKeys = [
  "acoEmail",
  "acoPassword",
  "cardLabel",
  "cardholder",
  "acoCardNumber",
  "expMonth",
  "expYear",
  "securityCode"
];

    const secrets =
      Object.fromEntries(
        secretKeys.map(key => [
          key,
          all[key] || ""
        ])
      );

    const profile = {
      ...all
    };

    secretKeys.forEach(key => {
      delete profile[key];
    });

    delete profile.confirm;

    if (message) {
      message.textContent =
        "Preparing secure Stripe checkoutâ€¦";
    }

    try {
      const response =
        await fetch(
          "/api/create-checkout-session",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            credentials:
              "same-origin",

            body: JSON.stringify({
  tier: state.tier,
  profile,
  secrets
})
          }
        );

      const data =
        await readJson(response);

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Checkout could not be started."
        );
      }

      if (!data.url) {
        throw new Error(
          "Stripe checkout URL was not returned."
        );
      }

      window.location.href =
        data.url;

    } catch (error) {
      if (message) {
        message.classList.add(
          "profile-validation-summary"
        );

        message.textContent =
          error.message;
      }
    }
  }
);


/* =====================================================
   EXPIRATION YEAR OPTIONS
===================================================== */

function fillExpirationYears(
  select
) {
  if (!select) return;

  const currentYear =
    new Date().getFullYear();

  for (
    let i = 0;
    i < 15;
    i++
  ) {
    const year =
      String(currentYear + i);

    if (
      Array.from(
        select.options
      ).some(
        option =>
          option.value === year
      )
    ) {
      continue;
    }

    const option =
      document.createElement(
        "option"
      );

    option.value = year;
    option.textContent = year;

    select.appendChild(option);
  }
}


fillExpirationYears(
  document.querySelector(
    '#profile-form [name="expYear"]'
  )
);

fillExpirationYears(
  document.getElementById(
    "edit-exp-year"
  )
);


/* =====================================================
   CARD NUMBER FORMATTING
===================================================== */

function bindCardFormatting(
  input
) {
  if (!input) return;

  input.addEventListener(
    "input",
    () => {
      const digits =
        input.value
          .replace(/\D/g, "")
          .slice(0, 19);

      input.value =
        digits
          .replace(
            /(\d{4})(?=\d)/g,
            "$1 "
          )
          .trim();
    }
  );
}


document
  .querySelectorAll(
    '[name="acoCardNumber"]'
  )
  .forEach(bindCardFormatting);


/* =====================================================
   SHOW / HIDE ACO PASSWORD
===================================================== */

const showPass =
  document.getElementById(
    "show-pass"
  );


showPass?.addEventListener(
  "click",
  () => {
    const input =
      document.querySelector(
        '#profile-form [name="acoPassword"]'
      );

    if (!input) return;

    const show =
      input.type === "password";

    input.type =
      show
        ? "text"
        : "password";

    showPass.textContent =
      show
        ? "Hide"
        : "Show";
  }
);

/* =====================================================
   GLOBAL CUSTOMER SHOW / HIDE
   One delegated handler for every dynamically rendered
   customer password / sensitive input.
===================================================== */

document.addEventListener(
  "click",
  event => {
    const button =
      event.target.closest(
        [
          "#show-pass",
          ".show-pass",
          "[data-retailer-password-toggle]",
          ".retailer-password-toggle",
          "[data-customer-password-toggle]",
          "[data-customer-sensitive-toggle]"
        ].join(",")
      );

    if (!button) {
      return;
    }

    const wrap =
      button.closest(
        [
          ".retailer-password-input-wrap",
          ".password-row",
          ".customer-sensitive-row",
          ".admin-sensitive-input-row"
        ].join(",")
      );

    const input =
      wrap?.querySelector(
        [
          "[data-customer-sensitive-input]",
          'input[type="password"]',
          'input[type="text"]'
        ].join(",")
      );

    if (!input) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const currentlyVisible =
      input.type === "text";

    try {
      input.type =
        currentlyVisible
          ? "password"
          : "text";
    } catch {
      return;
    }

    const nowVisible =
      input.type === "text";

    button.textContent =
      nowVisible
        ? "Hide"
        : "Show";

    button.setAttribute(
      "aria-label",
      nowVisible
        ? "Hide sensitive information"
        : "Show sensitive information"
    );
  },
  true
);


/* =====================================================
   PAYMENT RETURN / ACCOUNT LINK TOKENS
===================================================== */

const params =
  new URLSearchParams(
    location.search
  );


const paymentStatus =
  params.get("payment");

const rentalStatus =
  params.get("rental");

const resetToken =
  params.get("resetPassword") ||
  params.get("resetToken") ||
  params.get("reset_token");

const verifyEmailToken =
  params.get("verifyEmail") ||
  params.get("verifyEmailToken") ||
  params.get("verify_email_token");

const claimToken =
  params.get("claim") ||
  params.get("claimToken") ||
  params.get("claim_token");


if (paymentStatus === "success") {
  localStorage.setItem(
    "sng_recent_payment",
    "success"
  );

  history.replaceState(
    null,
    "",
    "/#my-profile"
  );

  setTimeout(() => {
    go("my-profile");
  }, 100);
}


if (rentalStatus === "success") {
  state.rentalCart = null;
  localStorage.removeItem(
    "sng_rental_cart"
  );
  updateCart();

  history.replaceState(
    null,
    "",
    "/#my-profile"
  );

  setTimeout(() => {
    go("my-profile");
    showAccountMessage(
      "Rental payment received. Your rented accounts will appear in your gifted and rented profiles after Stripe confirms the payment.",
      "success"
    );
  }, 150);
}

if (rentalStatus === "cancelled") {
  history.replaceState(
    null,
    "",
    "/#my-profile"
  );

  setTimeout(() => {
    go("my-profile");
    showAccountMessage(
      "Rental checkout was cancelled. Your rental selection is still in your cart.",
      "info"
    );
  }, 100);
}


if (paymentStatus === "cancelled") {
  history.replaceState(
    null,
    "",
    "/#profile"
  );

  setTimeout(() => {
    go("profile");

    const message =
      document.getElementById(
        "form-message"
      );

    if (message) {
      message.textContent =
        "Checkout was cancelled. Your selected membership is still saved.";
    }
  }, 100);
}


/* =====================================================
   ADMIN USER VIEW PREVIEW
===================================================== */

function adminPreviewDateFromNow(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function ensureAdminPreviewBanner() {
  if (!ADMIN_PREVIEW_MODE) return;
  if (document.getElementById("admin-user-preview-banner")) return;

  const style = document.createElement("style");
  style.textContent = `
    #admin-user-preview-banner {
      position: fixed;
      z-index: 99999;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: calc(100vw - 24px);
      padding: 9px 14px;
      border: 1px solid rgba(18,201,255,.72);
      border-radius: 999px;
      background: rgba(3,12,20,.94);
      color: #dff8ff;
      box-shadow: 0 0 28px rgba(18,201,255,.25);
      backdrop-filter: blur(12px);
      font-size: 11px;
      font-weight: 900;
      letter-spacing: .55px;
      white-space: nowrap;
    }
    #admin-user-preview-banner strong { color: #29d6ff; }
    #admin-user-preview-banner button {
      border: 0;
      border-radius: 999px;
      padding: 5px 9px;
      background: rgba(255,255,255,.08);
      color: #fff;
      font: inherit;
      cursor: pointer;
    }
    @media (max-width: 650px) {
      #admin-user-preview-banner {
        top: 8px;
        font-size: 9px;
        gap: 6px;
        padding: 7px 10px;
      }
    }
  `;
  document.head.appendChild(style);

  const banner = document.createElement("div");
  banner.id = "admin-user-preview-banner";
  banner.innerHTML = `
    <strong>ADMIN TEST CUSTOMER</strong>
    <span>PAID TEST MEMBERSHIP Â· ${escapeHtml(
      state.membership?.planName ||
      PLANS[ADMIN_PREVIEW_TIER]?.name ||
      "Paid Member"
    )}</span>
    <button type="button" id="admin-preview-reset">RESET TEST</button>
    <button type="button" id="admin-preview-close">CLOSE</button>
  `;
  document.body.appendChild(banner);

  document
    .getElementById(
      "admin-preview-reset"
    )
    ?.addEventListener(
      "click",
      () => {
        const confirmed =
          window.confirm(
            "Reset the Admin Test Customer? This only clears test data and does not affect real customers or inventory."
          );

        if (!confirmed) {
          return;
        }

        localStorage.removeItem(
          ADMIN_TEST_RENTALS_KEY
        );

        localStorage.removeItem(
          ADMIN_TEST_TIER_KEY
        );

        localStorage.removeItem(
          "sng_rental_cart"
        );

        localStorage.removeItem(
          "sng_selected_tier"
        );

        window.location.href =
          "/?adminPreview=1&adminPreviewTier=7#my-profile";

        window.location.reload();
      }
    );

  document
    .getElementById(
      "admin-preview-close"
    )
    ?.addEventListener(
      "click",
      () => window.close()
    );
}

function buildAdminPreviewProfile() {
  const previewTier =
    7;

  const plan =
    PLANS[previewTier] ||
    PLANS[7];
  const now = new Date().toISOString();
  const periodEnd = adminPreviewDateFromNow(30);

  state.customer = {
    id: "ADMIN-PREVIEW",
    email: "admin-preview@slabsngrabsaco.com",
    emailVerifiedAt: now
  };

  state.membership = {
    tier: previewTier,
    planName: plan.name,
    amount: plan.amount,
    profiles: plan.profiles,
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    subscriptionEndDate: periodEnd,
    cancelAtPeriodEnd: false
  };

  state.orders = [
    {
      orderNumber: "PREVIEW-1001",
      tier: previewTier,
      planName: plan.name,
      amount: plan.amount,
      profiles: plan.profiles,
      status: "active",
      paidAt: now,
      currentPeriodEnd: periodEnd,
      subscriptionEndDate: periodEnd
    }
  ];

  state.profileLoaded = true;
  state.retailerAllowance = plan.profiles;
  state.retailerProfiles = [];
  state.retailerProfilesLoaded = true;
  state.specialProfiles = [];
  state.freeMemberships = [];

  state.savedDetails = {
    addresses: [
      {
        id:
          "admin-test-address-1",
        label:
          "Test Home",
        firstName:
          "Admin",
        lastName:
          "Test Customer",
        address:
          "100 Test Lane",
        address2:
          "",
        city:
          "Test City",
        state:
          "FL",
        zip:
          "33301",
        country:
          "US"
      },
      {
        id:
          "admin-test-address-2",
        label:
          "Test Alternate",
        firstName:
          "Admin",
        lastName:
          "Test Customer",
        address:
          "200 Sample Avenue",
        address2:
          "Unit 2",
        city:
          "Test City",
        state:
          "FL",
        zip:
          "33302",
        country:
          "US"
      }
    ],

    paymentMethods: [
      {
        id:
          "admin-test-card-1",
        cardLabel:
          "Test Visa",
        cardholder:
          "Admin Test Customer",
        maskedNumber:
          "â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ 1111",
        expMonth:
          "12",
        expYear:
          "2030",
        testCardNumber:
          "4111111111111111"
      },
      {
        id:
          "admin-test-card-2",
        cardLabel:
          "Test Backup",
        cardholder:
          "Admin Test Customer",
        maskedNumber:
          "â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ â€¢â€¢â€¢â€¢ 4242",
        expMonth:
          "11",
        expYear:
          "2031",
        testCardNumber:
          "4242424242424242"
      }
    ]
  };

  state.rentedMemberships =
    adminTestReadRentals()
      .map(item => ({
        ...item,
        daysRemaining:
          item.expiresAt
            ? adminTestDaysRemaining(
                item.expiresAt
              )
            : null
      }))
      .filter(item =>
        !item.expiresAt ||
        new Date(
          item.expiresAt
        ).getTime() >
          Date.now()
      );

  adminTestSaveRentals(
    state.rentedMemberships
  );

  showSignedIn();
  renderAccountHeader(state.customer);
  renderMembership(state.membership);
  updatePricingUpgradeButtons();
  renderOrders(state.orders);
  populateEditOrderSelect(state.orders);
  renderRetailerProfiles();
  ensureAdminPreviewBanner();

  showAccountMessage(
    "Admin Test Customer is active. You can test paid-member and rental flows without creating a Stripe charge or touching real inventory.",
    "info"
  );

  loadManagedAvailabilityCustomer();
}

function adminPreviewSuccessData() {
  const now = new Date();
 m«ëŒ+Š×®º+º$zzb¥â6öç7B–W7FW&F’ÒæWrFFR†æ÷rævWEF–ÖR‚’ÒƒcC“°¢6öç7B¶W’ÒFFRÓâFFRçFô•4õ7G&–ær‚’ç6Æ–6RƒÂ“° ¢&WGW&â°¢ö³¢G'VRÀ¢7–æ3¢°¢7FGW3¢%&Wf–Wr6öææV7FVB"À¢Æ7E7–æ6VDC¢æ÷rçFô•4õ7G&–ær‚¢ÒÀ¢7VÖÖ'“¢°¢F÷FÄ6†V6¶÷WG3¢"À¢F÷FÄ—FV×3¢RÀ¢6†V6¶÷WEfÇVS¢#Bã“RÀ¢&W7DF“¢¢ÒÀ¢7F—f—G“¢°¢²FFS¢¶W’‡–W7FW&F’’Â6÷VçC¢ÂfÇVS¢“Bã“‚ÒÀ¢²FFS¢¶W’†æ÷r’Â6÷VçC¢ÂfÇVS¢’ã“rĞ¢ÒÀ¢&V6VçD6†V6¶÷WG3¢°¢°¢–C¢%$Ud”UrÔ4„T4´õUBÓ"À¢&WF–ÆW#¢%F&vWB"À¢÷&FW$çVÖ&W#¢%$Ud”UrÕDuBÓ"À¢6†V6¶÷WDC¢æ÷rçFô•4õ7G&–ær‚’À¢—FVÔ6÷VçC¢2À¢÷&FW%F÷FÃ¢’ã“rÀ¢7FGW3¢&6öæf—&ÖVB"À¢—FV×3¢°¢²æÖS¢%&Wf–Wr&öGV7B"ÂVçF—G“¢2Â&–6S¢3’ã“’Â–ÖvUW&Ã¢çVÆÂĞ¢Ğ¢ÒÀ¢°¢–C¢%$Ud”UrÔ4„T4´õUBÓ""À¢&WF–ÆW#¢%vÆÖ'B"À¢÷&FW$çVÖ&W#¢%$Ud”UrÕtÕBÓ""À¢6†V6¶÷WDC¢–W7FW&F’çFô•4õ7G&–ær‚’À¢—FVÔ6÷VçC¢"À¢÷&FW%F÷FÃ¢“Bã“‚À¢7FGW3¢&6öæf—&ÖVB"À¢—FV×3¢°¢²æÖS¢%&Wf–Wr&öGV7B"ÂVçF—G“¢"Â&–6S¢CrãC’Â–ÖvUW&Ã¢çVÆÂĞ¢Ğ¢Ğ¢Ğ¢Ó°§Ğ  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢5U5DôÔU"44õTåBT£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦6öç7B66÷VçDWF‚Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&66÷VçBÖWF‚ ¢“° ¦6öç7B7W7FöÖW$F6†&ö&BĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"ÖF6†&ö&B ¢“° ¦6öç7BÆöv–åæVÂĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&Æöv–â×æVÂ ¢“° ¦6öç7B&Vv—7FW%æVÂĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&Vv—7FW"×æVÂ ¢“° ¦6öç7Bf÷&v÷E77v÷&EæVÂĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&f÷&v÷B×77v÷&B×æVÂ ¢“° ¦6öç7B77v÷&E&W6WEæVÂĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'77v÷&B×&W6WB×æVÂ ¢“°  ¦gVæ7F–öâ6†÷u6–væVD÷WB‚’°¢7FFRæ7W7FöÖW"ÒçVÆÃ°§7FFRæÖVÖ&W'6†—ÒçVÆÃ°§7FFRçWw&FTÖöFRÒfÇ6S°§7FFRæ÷&FW'2ÒµÓ° §7FFRæg&VTÖVÖ&W'6†—2ÒµÓ°§7FFRç&VçFVDÖVÖ&W'6†—2ÒµÓ° §7FFRç6fVDFWF–Ç2Ò°¢FG&W76W3¢µÒÀ¢–ÖVçDÖWF†öG3¢µĞ§Ó° §7FFRæ66÷VçE7FG2Ò°¢W6W%6–æ6S¢çVÆÂÀ¢Æ–fWF–ÖU7VæC¢À¢F÷FÄ÷&FW'3¢ §Ó° §7FFRç&öf–ÆTÆöFVBÒG'VS° §WFFU&–6–æuWw&FT'WGFöç2‚“° ¢–b†66÷VçDWF‚’°¢66÷VçDWF‚æ†–FFVâÒfÇ6S°¢Ğ ¢–b†7W7FöÖW$F6†&ö&B’°¢7W7FöÖW$F6†&ö&Bæ†–FFVâÒG'VS°¢Ğ ¢–b†Æöv–åæVÂ’°¢Æöv–åæVÂæ†–FFVâÒfÇ6S°¢Ğ ¢–b‡&Vv—7FW%æVÂ’°¢&Vv—7FW%æVÂæ†–FFVâÒfÇ6S°¢Ğ ¢–b†f÷&v÷E77v÷&EæVÂ’°¢f÷&v÷E77v÷&EæVÂæ†–FFVâÒG'VS°¢Ğ ¢–b‡77v÷&E&W6WEæVÂ’°¢77v÷&E&W6WEæVÂæ†–FFVâÒG'VS°¢Ğ§Ğ  ¦gVæ7F–öâ6†÷u6–væVD–â‚’°¢–b†66÷VçDWF‚’°¢66÷VçDWF‚æ†–FFVâÒG'VS°¢Ğ ¢–b†7W7FöÖW$F6†&ö&B’°¢7W7FöÖW$F6†&ö&Bæ†–FFVâÒfÇ6S°¢7W7FöÖW$F6†&ö&Bç&VÖ÷fTGG&–'WFR€¢&†–FFVâ ¢“°¢7W7FöÖW$F6†&ö&Bç7G–ÆRæF—7Æ’Ğ¢"#°¢Ğ ¢7v—F6„66÷VçEF"€¢&ÖVÖ&W'6†— ¢“°§Ğ  ¦gVæ7F–öâ6†÷tf÷&v÷E77v÷&B‚’°¢6ÆV$66÷VçDÖW76vR‚“° ¢–b†Æöv–åæVÂ’°¢Æöv–åæVÂæ†–FFVâÒG'VS°¢Ğ ¢–b‡&Vv—7FW%æVÂ’°¢&Vv—7FW%æVÂæ†–FFVâÒG'VS°¢Ğ ¢–b†f÷&v÷E77v÷&EæVÂ’°¢f÷&v÷E77v÷&EæVÂæ†–FFVâÒfÇ6S°¢Ğ ¢–b‡77v÷&E&W6WEæVÂ’°¢77v÷&E&W6WEæVÂæ†–FFVâÒG'VS°¢Ğ§Ğ  ¦gVæ7F–öâ6†÷tæ÷&ÖÄWF‚‚’°¢6ÆV$66÷VçDÖW76vR‚“° ¢–b†Æöv–åæVÂ’°¢Æöv–åæVÂæ†–FFVâÒfÇ6S°¢Ğ ¢–b‡&Vv—7FW%æVÂ’°¢&Vv—7FW%æVÂæ†–FFVâÒfÇ6S°¢Ğ ¢–b†f÷&v÷E77v÷&EæVÂ’°¢f÷&v÷E77v÷&EæVÂæ†–FFVâÒG'VS°¢Ğ ¢–b‡77v÷&E&W6WEæVÂ’°¢77v÷&E&W6WEæVÂæ†–FFVâÒG'VS°¢Ğ§Ğ  ¦gVæ7F–öâ6†÷u77v÷&E&W6WB‚’°¢–b†66÷VçDWF‚’°¢66÷VçDWF‚æ†–FFVâÒfÇ6S°¢Ğ ¢–b†7W7FöÖW$F6†&ö&B’°¢7W7FöÖW$F6†&ö&Bæ†–FFVâÒG'VS°¢Ğ ¢–b†Æöv–åæVÂ’°¢Æöv–åæVÂæ†–FFVâÒG'VS°¢Ğ ¢–b‡&Vv—7FW%æVÂ’°¢&Vv—7FW%æVÂæ†–FFVâÒG'VS°¢Ğ ¢–b†f÷&v÷E77v÷&EæVÂ’°¢f÷&v÷E77v÷&EæVÂæ†–FFVâÒG'VS°¢Ğ ¢–b‡77v÷&E&W6WEæVÂ’°¢77v÷&E&W6WEæVÂæ†–FFVâÒfÇ6S°¢Ğ ¢vò‚&×’×&öf–ÆR"“°§Ğ  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'6†÷rÖf÷&v÷B×77v÷&B ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢6†÷tf÷&v÷E77v÷&@¢“°  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&&6²×FòÖÆöv–â ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢6†÷tæ÷&ÖÄWF€¢“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢$Tt•5DU £ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦6öç7B&Vv—7FW$f÷&ÒĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'&Vv—7FW"Öf÷&Ò ¢“° ¦ÆWBVæF–ætF—66÷&E6–vçWF–6¶WBÒ"#°¦gVæ7F–öâ÷VäF—66÷&EfW&–f–6F–öâ†6öçFW‡B’°¢6öç7B÷WÒv–æF÷ræ÷Vâ†ö’öF—66÷&BööWF‚÷7F'Cö6öçFW‡CÒG¶6öçFW‡GÖÂ&F—66÷&B×fW&–f–6F–öâ"Â'÷W×–W2Çv–GFƒÓSCÆ†V–v‡CÓsc"“°¢–b‚÷W’6†÷t66÷VçDÖW76vR‚$ÆÆ÷r÷W2f÷"F†—26—FRFòfW&–g’–÷W"F—66÷&B66÷VçBâ"Â&W'&÷""“°§Ğ¦Fö7VÖVçBçVW'•6VÆV7F÷"‚r7&Vv—7FW"Öf÷&Ò¶æÖSÒ&F—66÷&EW6W&æÖR%Òr“òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ÷VäF—66÷&EfW&–f–6F–öâ‚'6–vçW"’“°¦Fö7VÖVçBçVW'•6VÆV7F÷"‚r6F—66÷&B×6WGF–æw2Öf÷&Ò¶æÖSÒ&F—66÷&EW6W&æÖR%Òr“òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ°¢–b‡7FFRæ7W7FöÖW"’÷VäF—66÷&EfW&–f–6F–öâ‚&66÷VçB"“°§Ò“°§v–æF÷ræFDWfVçDÆ—7FVæW"‚&ÖW76vR"ÂWfVçBÓâ°¢–b†WfVçBæ÷&–v–âÓÒv–æF÷ræÆö6F–öâæ÷&–v–âÇÂWfVçBæFFòçG—RÓÒ'6Æ'6æw&'66òÖF—66÷&B"’&WGW&ã°¢–b†WfVçBæFFæW'&÷"’²6†÷t66÷VçDÖW76vR†WfVçBæFFæW'&÷"Â&W'&÷""“²&WGW&ã²Ğ¢–b†WfVçBæFFçF–6¶WB’°¢VæF–ætF—66÷&E6–vçWF–6¶WBÒWfVçBæFFçF–6¶WC°¢6öç7Bf–VÆBÒFö7VÖVçBçVW'•6VÆV7F÷"‚r7&Vv—7FW"Öf÷&Ò¶æÖSÒ&F—66÷&EW6W&æÖR%Òr“°¢–b†f–VÆB’f–VÆBçfÇVRÒWfVçBæFFçW6W&æÖS°¢Ğ¢–b†WfVçBæFFæÆ–æ¶VB’°¢6öç7Bf–VÆBÒFö7VÖVçBçVW'•6VÆV7F÷"‚r6F—66÷&B×6WGF–æw2Öf÷&Ò¶æÖSÒ&F—66÷&EW6W&æÖR%Òr“°¢–b†f–VÆB’f–VÆBçfÇVRÒWfVçBæFFçW6W&æÖS°¢7FFRæ7W7FöÖW"Ò²ââç7FFRæ7W7FöÖW"ÂF—66÷&EW6W&æÖS¢WfVçBæFFçW6W&æÖRÂF—66÷&DÆ–æ¶VC¢G'VRÓ°¢&VæFW$7W7FöÖW$F—66÷&E6WGF–æw2‚“°¢Ğ¢6†÷t66÷VçDÖW76vR‚$F—66÷&B66÷VçBfW&–f–VBæBÆ–æ¶VBâ"Â'7V66W72"“°§Ò“°  §&Vv—7FW$f÷&ÓòæFDWfVçDÆ—7FVæW"€¢'7V&Ö—B"À¢7–æ2WfVçBÓâ°¢WfVçBç&WfVçDFVfVÇB‚“° ¢6ÆV$66÷VçDÖW76vR‚“° ¢6öç7Bf÷&ÒĞ¢WfVçBæ7W'&VçEF&vWC° ¢6öç7B'WGFöâĞ¢f÷&ÒçVW'•6VÆV7F÷"€¢v'WGFöå·G—SÒ'7V&Ö—B%Òp¢“° ¢6öç7BFFĞ¢ö&¦V7Bæg&öÔVçG&–W2€¢æWrf÷&ÔFF†f÷&Ò’æVçG&–W2‚¢“° ¢–b€¢FFç77v÷&BÓĞ¢FFæ6öæf—&Õ77v÷&@¢’°¢6†÷t66÷VçDÖW76vR€¢%–÷W"77v÷&G2Fòæ÷BÖF6‚â"À¢&W'&÷" ¢“° ¢&WGW&ã°¢Ğ ¢–b€¢7G&–ær€¢FFç77v÷&BÇÂ" ¢’æÆVæwF‚Â ¢’°¢6†÷t66÷VçDÖW76vR€¢%–÷W"77v÷&B×W7B&RBÆV7B"6†&7FW'2â"À¢&W'&÷" ¢“° ¢&WGW&ã°¢Ğ ¢G'’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢G'VRÀ¢$7&VF–ær66÷VçN(
b ¢“° ¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö66÷VçB÷&Vv—7FW""À¢°¢ÖWF†öC¢%õ5B"À ¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ ¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À ¢&öG“¢¥4ôâç7G&–æv–g’‡°¢VÖ–Ã ¢7G&–ær€¢FFæVÖ–ÂÇÂ" ¢’çG&–Ò‚’À ¢77v÷&C ¢FFç77v÷&BÀ ¢F—66÷&EW6W&æÖS ¢7G&–ær€¢FFæF—66÷&EW6W&æÖRÇÀ¢" ¢’çG&–Ò‚’À ¢F—66÷&EfW&–f–6F–öåF–6¶WC¢VæF–ætF—66÷&E6–vçWF–6¶W@¢Ò¢Ğ¢“° ¢6öç7B&W7VÇBĞ¢v—B&VD§6öâ‡&W7öç6R“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢&W7VÇBæW'&÷"ÇÀ¢$66÷VçB6÷VÆBæ÷B&R7&VFVBâ ¢“°¢Ğ ¢f÷&Òç&W6WB‚“°¢VæF–ætF—66÷&E6–vçWF–6¶WBÒ"#° ¢6†÷t66÷VçDÖW76vR€¢&W7VÇBæÖW76vRÇÀ¢%–÷W"66÷VçBv27&VFVBâ6†V6²–÷W"VÖ–Âf÷"F†RfW&–f–6F–öâÆ–æ²â"À¢'7V66W72 ¢“° ¢v—BÆöDÖVÖ&W%&öf–ÆR€¢G'VP¢“° ¢Ò6F6‚†W'&÷"’°¢6†÷t66÷VçDÖW76vR€¢W'&÷"æÖW76vRÀ¢&W'&÷" ¢“° ¢Òf–æÆÇ’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢fÇ6P¢“°¢Ğ¢Ğ¢“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢Äôt”à£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦6öç7BÆöv–äf÷&ÒĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&Æöv–âÖf÷&Ò ¢“°  ¦Æöv–äf÷&ÓòæFDWfVçDÆ—7FVæW"€¢'7V&Ö—B"À¢7–æ2WfVçBÓâ°¢WfVçBç&WfVçDFVfVÇB‚“° ¢6ÆV$66÷VçDÖW76vR‚“° ¢6öç7Bf÷&ÒĞ¢WfVçBæ7W'&VçEF&vWC° ¢6öç7B'WGFöâĞ¢f÷&ÒçVW'•6VÆV7F÷"€¢v'WGFöå·G—SÒ'7V&Ö—B%Òp¢“° ¢6öç7BFFĞ¢ö&¦V7Bæg&öÔVçG&–W2€¢æWrf÷&ÔFF†f÷&Ò’æVçG&–W2‚¢“° ¢G'’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢G'VRÀ¢%6–væ–ær–î(
b ¢“° ¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö66÷VçBöÆöv–â"À¢°¢ÖWF†öC¢%õ5B"À ¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ ¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À ¢&öG“¢¥4ôâç7G&–æv–g’‡°¢VÖ–Ã ¢7G&–ær€¢FFæVÖ–ÂÇÂ" ¢’çG&–Ò‚’À ¢77v÷&C ¢FFç77v÷&@¢Ò¢Ğ¢“° ¢6öç7B&W7VÇBĞ¢v—B&VD§6öâ‡&W7öç6R“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢&W7VÇBæW'&÷"ÇÀ¢%Væ&ÆRFò6–vâ–ââ ¢“°¢Ğ ¢f÷&Òç&W6WB‚“° ¢6†÷t66÷VçDÖW76vR€¢&W7VÇBæÖW76vRÇÀ¢%6–væVB–â7V66W76gVÆÇ’â"À¢'7V66W72 ¢“° ¢v—BÆöDÖVÖ&W%&öf–ÆR€¢G'VP¢“° ¢Ò6F6‚†W'&÷"’°¢6†÷t66÷VçDÖW76vR€¢W'&÷"æÖW76vRÀ¢&W'&÷" ¢“° ¢Òf–æÆÇ’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢fÇ6P¢“°¢Ğ¢Ğ¢“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢ÄôtõU@£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&7W7FöÖW"ÖÆöv÷WB ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢7–æ2‚’Óâ°¢6ÆV$66÷VçDÖW76vR‚“° ¢G'’°¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö66÷VçBöÆöv÷WB"À¢°¢ÖWF†öC¢%õ5B"À ¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â ¢Ğ¢“° ¢–b‚&W7öç6Ræö²’°¢6öç7B&W7VÇBĞ¢v—B&VD§6öâ‡&W7öç6R“° ¢F‡&÷ræWrW'&÷"€¢&W7VÇBæW'&÷"ÇÀ¢%Væ&ÆRFòÆör÷WBâ ¢“°¢Ğ ¢6†÷u6–væVD÷WB‚“° ¢6†÷t66÷VçDÖW76vR€¢%–÷R†fR&VVâÆövvVB÷WBâ"À¢'7V66W72 ¢“° ¢Ò6F6‚†W'&÷"’°¢6†÷t66÷VçDÖW76vR€¢W'&÷"æÖW76vRÀ¢&W'&÷" ¢“°¢Ğ¢Ğ¢“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢dõ$tõB55tõ$@£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦6öç7Bf÷&v÷E77v÷&Df÷&ÒĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&f÷&v÷B×77v÷&BÖf÷&Ò ¢“°  ¦f÷&v÷E77v÷&Df÷&Ğ¢òæFDWfVçDÆ—7FVæW"€¢'7V&Ö—B"À¢7–æ2WfVçBÓâ°¢WfVçBç&WfVçDFVfVÇB‚“° ¢–b„DÔ”åõ$Ud”UuôÔôDR’°¢v–æF÷ræÆW'B€¢$FÖ–âW6W"f–Wr&Wf–Ws¢ÖVÖ&W'6†—6†V6¶÷WB—2F—6&ÆVB6òæò&VÂ7G&—R7V'67&—F–öâ6â&R7&VFVBâ ¢“°¢&WGW&ã°¢Ğ ¢6ÆV$66÷VçDÖW76vR‚“° ¢6öç7Bf÷&ÒĞ¢WfVçBæ7W'&VçEF&vWC° ¢6öç7B'WGFöâĞ¢f÷&ÒçVW'•6VÆV7F÷"€¢v'WGFöå·G—SÒ'7V&Ö—B%Òp¢“° ¢6öç7BFFĞ¢ö&¦V7Bæg&öÔVçG&–W2€¢æWrf÷&ÔFF€¢f÷&Ğ¢’æVçG&–W2‚¢“° ¢G'’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢G'VRÀ¢%6VæF–æ~(
b ¢“° ¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö66÷VçB÷&WVW7B×77v÷&B×&W6WB"À¢°¢ÖWF†öC¢%õ5B"À ¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ ¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À ¢&öG“ ¢¥4ôâç7G&–æv–g’‡°¢VÖ–Ã ¢7G&–ær€¢FFæVÖ–ÂÇÀ¢" ¢’çG&–Ò‚¢Ò¢Ğ¢“° ¢6öç7B&W7VÇBĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢&W7VÇBæW'&÷"ÇÀ¢%Væ&ÆRFò6VæB77v÷&B&W6WBVÖ–Ââ ¢“°¢Ğ ¢f÷&Òç&W6WB‚“° ¢6†÷t66÷VçDÖW76vR€¢&W7VÇBæÖW76vRÇÀ¢$–bâ66÷VçBW†—7G2f÷"F†BVÖ–ÂÂ77v÷&B&W6WBÆ–æ²†2&VVâ6VçBâ"À¢'7V66W72 ¢“° ¢Ò6F6‚†W'&÷"’°¢6†÷t66÷VçDÖW76vR€¢W'&÷"æÖW76vRÀ¢&W'&÷" ¢“° ¢Òf–æÆÇ’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢fÇ6P¢“°¢Ğ¢Ğ¢“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢$U4UB55tõ$@£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦6öç7B77v÷&E&W6WDf÷&ÒĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'77v÷&B×&W6WBÖf÷&Ò ¢“°  §77v÷&E&W6WDf÷&Ğ¢òæFDWfVçDÆ—7FVæW"€¢'7V&Ö—B"À¢7–æ2WfVçBÓâ°¢WfVçBç&WfVçDFVfVÇB‚“° ¢6ÆV$66÷VçDÖW76vR‚“° ¢6öç7Bf÷&ÒĞ¢WfVçBæ7W'&VçEF&vWC° ¢6öç7B'WGFöâĞ¢f÷&ÒçVW'•6VÆV7F÷"€¢v'WGFöå·G—SÒ'7V&Ö—B%Òp¢“° ¢6öç7BFFĞ¢ö&¦V7Bæg&öÔVçG&–W2€¢æWrf÷&ÔFF€¢f÷&Ğ¢’æVçG&–W2‚¢“° ¢–b‚&W6WEFö¶Vâ’°¢6†÷t66÷VçDÖW76vR€¢%F†—277v÷&B&W6WBÆ–æ²—2Ö—76–ær—G26V7W&RFö¶Vââ"À¢&W'&÷" ¢“° ¢&WGW&ã°¢Ğ ¢–b€¢FFç77v÷&BÓĞ¢FFæ6öæf—&Õ77v÷&@¢’°¢6†÷t66÷VçDÖW76vR€¢%–÷W"77v÷&G2Fòæ÷BÖF6‚â"À¢&W'&÷" ¢“° ¢&WGW&ã°¢Ğ ¢–b€¢7G&–ær€¢FFç77v÷&BÇÂ" ¢’æÆVæwF‚Â ¢’°¢6†÷t66÷VçDÖW76vR€¢%–÷W"77v÷&B×W7B&RBÆV7B"6†&7FW'2â"À¢&W'&÷" ¢“° ¢&WGW&ã°¢Ğ ¢G'’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢G'VRÀ¢%&W6WGF–æ~(
b ¢“° ¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö66÷VçB÷&W6WB×77v÷&B"À¢°¢ÖWF†öC¢%õ5B"À ¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ ¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À ¢&öG“ ¢¥4ôâç7G&–æv–g’‡°¢Fö¶Vã ¢&W6WEFö¶VâÀ ¢77v÷&C ¢FFç77v÷&@¢Ò¢Ğ¢“° ¢6öç7B&W7VÇBĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢&W7VÇBæW'&÷"ÇÀ¢%Væ&ÆRFò&W6WB–÷W"77v÷&Bâ ¢“°¢Ğ ¢f÷&Òç&W6WB‚“° ¢†—7F÷'’ç&WÆ6U7FFR€¢çVÆÂÀ¢""À¢"ò6×’×&öf–ÆR ¢“° ¢6†÷tæ÷&ÖÄWF‚‚“° ¢6†÷t66÷VçDÖW76vR€¢&W7VÇBæÖW76vRÇÀ¢%–÷W"77v÷&B†2&VVâ&W6WBâ–÷R6âæ÷r6–vâ–ââ"À¢'7V66W72 ¢“° ¢Ò6F6‚†W'&÷"’°¢6†÷t66÷VçDÖW76vR€¢W'&÷"æÖW76vRÀ¢&W'&÷" ¢“° ¢Òf–æÆÇ’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢fÇ6P¢“°¢Ğ¢Ğ¢“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢TÔ”ÂdU$”d”4D”ôà£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦7–æ2gVæ7F–öâfW&–g”7W7FöÖW$VÖ–Â€¢Fö¶Và¢’°¢–b‚Fö¶Vâ’&WGW&ã° ¢vò‚&×’×&öf–ÆR"“° ¢6†÷t66÷VçDÖW76vR€¢%fW&–g––ær–÷W"VÖ–Î(
b"À¢&–æfò ¢“° ¢G'’°¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö66÷VçB÷fW&–g’ÖVÖ–Â"À¢m«ëŒ+Š×®º+º$zzb¥à    {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          credentials:
            "same-origin",

          body:
            JSON.stringify({
              token
            })
        }
      );

    const result =
      await readJson(
        response
      );

    if (!response.ok) {
      throw new Error(
        result.error ||
        "Email verification failed."
      );
    }

    history.replaceState(
      null,
      "",
      "/#my-profile"
    );

    showAccountMessage(
      result.message ||
      "Your email has been verified.",
      "success"
    );

    await loadMemberProfile(
      true
    );

  } catch (error) {
    showAccountMessage(
      error.message,
      "error"
    );
  }
}


/* =====================================================
   RESEND EMAIL VERIFICATION
===================================================== */

async function resendVerification() {
  clearAccountMessage();

  try {
    const response =
      await fetch(
        "/api/account/resend-verification",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          credentials:
            "same-origin",

          body:
            JSON.stringify({})
        }
      );

    const result =
      await readJson(
        response
      );

    if (!response.ok) {
      throw new Error(
        result.error ||
        "Unable to send verification email."
      );
    }

    showAccountMessage(
      result.message ||
      "Verification email sent.",
      "success"
    );

  } catch (error) {
    showAccountMessage(
      error.message,
      "error"
    );
  }
}


document
  .getElementById(
    "resend-verification"
  )
  ?.addEventListener(
    "click",
    resendVerification
  );


document
  .getElementById(
    "security-resend-verification"
  )
  ?.addEventListener(
    "click",
    resendVerification
  );


/* =====================================================
   SECURITY PASSWORD RESET
===================================================== */

document
  .getElementById(
    "security-password-reset"
  )
  ?.addEventListener(
    "click",
    async () => {
      clearAccountMessage();

      const email =
        state.customer?.email;

      if (!email) {
        showAccountMessage(
          "Unable to determine your account email.",
          "error"
        );

        return;
      }

      try {
        const response =
          await fetch(
            "/api/account/request-password-reset",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              credentials:
                "same-origin",

              body:
                JSON.stringify({
                  email
                })
            }
          );

        const result =
          await readJson(
            response
          );

        if (!response.ok) {
          throw new Error(
            result.error ||
            "Unable to send password reset email."
          );
        }

        showAccountMessage(
          result.message ||
          "Password reset email sent.",
          "success"
        );

      } catch (error) {
        showAccountMessage(
          error.message,
          "error"
        );
      }
    }
  );


/* =====================================================
   ACCOUNT TABS
===================================================== */

function switchAccountTab(
  tabName
) {
  document
    .querySelectorAll(
      "[data-account-tab]"
    )
    .forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset
          .accountTab ===
          tabName
      );
    });

  document
    .querySelectorAll(
      "[data-account-panel]"
    )
    .forEach(panel => {
      const active =
        panel.dataset
          .accountPanel ===
        tabName;

      panel.classList.toggle(
        "active",
        active
      );

      panel.hidden = !active;
    });
}


document
  .querySelectorAll(
    "[data-account-tab]"
  )
  .forEach(button => {
    button.addEventListener(
      "click",
      () => {
        switchAccountTab(
          button.dataset
            .accountTab
        );
      }
    );
  });


/* =====================================================
   LINK EXISTING ORDER
===================================================== */

const claimOrderForm =
  document.getElementById(
    "claim-order-form"
  );


claimOrderForm?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const form =
      event.currentTarget;

    const message =
      document.getElementById(
        "claim-order-message"
      );

    const button =
      form.querySelector(
        'button[type="submit"]'
      );

    const data =
      Object.fromEntries(
        new FormData(
          form
        ).entries()
      );

    const orderNumber =
      String(
        data.orderNumber || ""
      ).trim();

    const email =
      String(
        data.email || ""
      ).trim();

    const phone =
      String(
        data.phone || ""
      ).trim();

    if (!email && !phone) {
      setMessage(
        message,
        "Enter either the purchase email or purchase phone number.",
        "error"
      );

      return;
    }

    try {
      setButtonBusy(
        button,
        true,
        "Verifyingâ€¦"
      );

      setMessage(
        message,
        ""
      );

      const response =
        await fetch(
          "/api/account/claim-order",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            credentials:
              "same-origin",

            body:
              JSON.stringify({
                orderNumber,
                email,
                phone
              })
          }
        );

      const result =
        await readJson(
          response
        );

      if (!response.ok) {
        throw new Error(
          result.error ||
          "Unable to verify that order."
        );
      }

      form.reset();

      setMessage(
        message,
        result.message ||
        "If the information matches, a secure verification link has been sent to the email address on the order.",
        "success"
      );

    } catch (error) {
      setMessage(
        message,
        error.message,
        "error"
      );

    } finally {
      setButtonBusy(
        button,
        false
      );
    }
  }
);


/* =====================================================
   VERIFY ORDER CLAIM
===================================================== */

async function verifyOrderClaim(
  token
) {
  if (!token) return;

  go("my-profile");

  showAccountMessage(
    "Verifying your orderâ€¦",
    "info"
  );

  try {
    const response =
      await fetch(
        "/api/account/verify-order-claim",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          credentials:
            "same-origin",

          body:
            JSON.stringify({
              token
            })
        }
      );

    const result =
      await readJson(
        response
      );

    if (!response.ok) {
      throw new Error(
        result.error ||
        "Unable to link this order."
      );
    }

    history.replaceState(
      null,
      "",
      "/#my-profile"
    );

    showAccountMessage(
      result.message ||
      "Your order has been linked to your account.",
      "success"
    );

    await loadMemberProfile(
      true
    );

  } catch (error) {
    showAccountMessage(
      error.message,
      "error"
    );
  }
}
/* =====================================================
   CUSTOMER PROFILE RENDERING
===================================================== */

function setText(id, value) {
  const element =
    document.getElementById(id);

  if (!element) return;

  element.textContent =
    value ?? "â€”";
}


function renderAccountHeader(
  account
) {
  const email =
    account?.email || "Member";

  const verified =
    Boolean(
      account?.emailVerifiedAt
    );

  const stats =
    state.accountStats || {};

  setText(
    "customer-account-name",
    stats.displayName ||
    "Member"
  );

  setText(
    "customer-account-email",
    email
  );

  const ogMemberBadge =
    document.getElementById(
      "og-member-badge"
    );

  if (ogMemberBadge) {
    ogMemberBadge.hidden =
      stats.ogMember !==
      true;
  }

  setText(
    "security-email",
    email
  );

  setText(
    "email-verification-status",
    verified
      ? "Email verified"
      : "Email not verified"
  );

  setText(
    "security-email-status",
    verified
      ? "Verified"
      : "Not Verified"
  );

  const headerVerificationStatus =
    document.getElementById(
      "email-verification-status"
    );

  const securityVerificationStatus =
    document.getElementById(
      "security-email-status"
    );

  [
    headerVerificationStatus,
    securityVerificationStatus
  ]
    .filter(Boolean)
    .forEach(element => {
      element.classList.toggle(
        "verification-verified",
        verified
      );

      element.classList.toggle(
        "verification-unverified",
        !verified
      );
    });

  setText(
    "member-since",
    stats.userSince
      ? formatDate(
          stats.userSince
        )
      : (
          account.createdAt
            ? formatDate(
                account.createdAt
              )
            : "â€”"
        )
  );

  setText(
    "member-lifetime-spend",
    `$${Number(
      stats.lifetimeSpend || 0
    ).toFixed(2)}`
  );

  setText(
    "member-total-orders",
    String(
      Number(
        stats.totalOrders || 0
      )
    )
  );


  const resend =
    document.getElementById(
      "resend-verification"
    );

  const securityResend =
    document.getElementById(
      "security-resend-verification"
    );

  if (resend) {
    resend.hidden = verified;
  }

  if (securityResend) {
    securityResend.hidden =
      verified;
  }
}


/* =====================================================
   PAID MEMBERSHIP ACCESS
===================================================== */

function hasActivePaidMembership(
  membership = state.membership
) {
  if (!membership) return false;

  const status =
    String(
      membership?.status ||
      membership?.subscriptionStatus ||
      ""
    )
      .trim()
      .toLowerCase();

  if (
    [
      "canceled",
      "cancelled",
      "unpaid",
      "incomplete_expired",
      "paused"
    ].includes(status)
  ) {
    return false;
  }

  if (
    [
      "active",
      "trialing"
    ].includes(status)
  ) {
    return true;
  }

  const endDate =
    membership.subscriptionEndDate ||
    membership.currentPeriodEnd ||
    membership.cancelAt ||
    null;

  if (endDate) {
    const end =
      new Date(
        endDate
      ).getTime();

    if (
      Number.isFinite(end) &&
      end > Date.now()
    ) {
      return true;
    }
  }

  return false;
}


function updateRentalMembershipAccess(
  membership = state.membership
) {
  const allowed =
    hasActivePaidMembership(
      membership
    );

  const rentalTab =
    document.querySelector(
      '[data-account-tab="availability"]'
    );

  const rentalPanel =
    document.querySelector(
      '[data-account-panel="availability"]'
    );

  const rentalAddButton =
    document.getElementById(
      "rental-add-to-cart"
    );

  if (rentalTab) {
    rentalTab.hidden =
      !allowed;

    rentalTab.disabled =
      !allowed;
  }

  if (!allowed) {
    if (rentalPanel) {
      rentalPanel.hidden =
        true;

      rentalPanel.classList.remove(
        "active"
      );
    }

    if (rentalAddButton) {
      rentalAddButton.disabled =
        true;
    }

    if (
      rentalTab?.classList.contains(
        "active"
      )
    ) {
      document
        .querySelectorAll(
          "[data-account-tab]"
        )
        .forEach(button =>
          button.classList.remove(
            "active"
          )
        );

      document
        .querySelectorAll(
          "[data-account-panel]"
        )
        .forEach(panel => {
          panel.classList.remove(
            "active"
          );

          panel.hidden =
            true;
        });

      const membershipTab =
        document.querySelector(
          '[data-account-tab="membership"]'
        );

      const membershipPanel =
        document.querySelector(
          '[data-account-panel="membership"]'
        );

      membershipTab
        ?.classList.add(
          "active"
        );

      if (membershipPanel) {
        membershipPanel.hidden =
          false;

        membershipPanel.classList.add(
          "active"
        );
      }
    }
  }

  return allowed;
}


/* =====================================================
   MEMBERSHIP RENDERING
===================================================== */


function customerTierColorClass(
  tier
) {
  const tierNumber =
    Number(tier);

  return tierNumber >= 1 &&
    tierNumber <= 7
      ? `customer-tier-color-${tierNumber}`
      : "";
}


function customerTierStatusClass(
  tier
) {
  const tierNumber =
    Number(tier);

  return tierNumber >= 1 &&
    tierNumber <= 7
      ? `customer-tier-status-${tierNumber}`
      : "";
}


function renderMembership(
  membership
) {
    const upgradeButton =
    document.getElementById(
      "upgrade-membership"
    );

    if (!membership) {
    if (upgradeButton) {
      upgradeButton.disabled =
        false;

      upgradeButton.textContent =
        "Get Membership";
    }

    updateRentalMembershipAccess(
      null
    );
  }

  if (!membership) {
    setText(
      "membership-plan-name",
      "No active membership"
    );

    setText(
      "membership-status",
      "â€”"
    );

    setText(
      "membership-price",
      "â€”"
    );

    setText(
      "membership-profiles",
      "â€”"
    );

    setText(
      "membership-period-end",
      "â€”"
    );

    setText(
      "membership-days-remaining",
      "â€”"
    );

    setText(
      "detail-plan",
      "â€”"
    );

    setText(
      "detail-status",
      "â€”"
    );

    setText(
      "detail-price",
      "â€”"
    );

    setText(
      "detail-profiles",
      "â€”"
    );

    setText(
      "detail-period-end",
      "â€”"
    );

    setText(
      "membership-description",
      "You do not currently have a membership linked to this account."
    );

    return;
  }

  const tier =
    Number(
      membership.tier
    );

  updateRentalMembershipAccess(
    membership
  );

    if (upgradeButton) {
  if (
    membership
      .cancelAtPeriodEnd ===
    true
  ) {
    upgradeButton.disabled =
      true;

    upgradeButton.textContent =
      "Reactivate to Upgrade";

  } else if (
    tier >= 7
  ) {
    upgradeButton.disabled =
      true;

    upgradeButton.textContent =
      "Highest Tier";

  } else if (
    PLANS[tier]
  ) {
    upgradeButton.disabled =
      false;

    upgradeButton.textContent =
      "Upgrade Membership";

  } else {
    upgradeButton.disabled =
      true;

    upgradeButton.textContent =
      "Upgrade Membership";
  }
}

  const localPlan =
    PLANS[tier] || null;

  const planName =
    membership.planName ||
    localPlan?.name ||
    "Membership";

  const amount =
    membership.amount ??
    localPlan?.amount ??
    null;

  const profiles =
    membership.profiles ??
    localPlan?.profiles ??
    null;

  const status =
    normalizeStatus(
      membership.status
    );

  const periodEnd =
    membership.subscriptionEndDate ||
    membership.currentPeriodEnd ||
    membership.cancelAt ||
    null;

  const daysRemaining =
    Number.isFinite(
      Number(
        membership.daysRemaining
      )
    )
      ? Math.max(
          0,
          Number(
            membership.daysRemaining
          )
        )
      : calculateDaysRemaining(
          periodEnd
        );

  const priceText =
    amount != null
      ? `$${amount}/month`
      : "â€”";

  const profileText =
    profiles != null
      ? String(profiles)
      : "â€”";

  const dateText =
    periodEnd
      ? formatDate(periodEnd)
      : "â€”";

  setText(
    "membership-plan-name",
    planName
  );

  const membershipPlanNameElement =
    document.getElementById(
      "membership-plan-name"
    );

  if (membershipPlanNameElement) {
    for (
      let tierNumber = 1;
      tierNumber <= 7;
      tierNumber += 1
    ) {
      membershipPlanNameElement.classList.remove(
        `customer-tier-color-${tierNumber}`
      );
    }

    const planTierClass =
      customerTierColorClass(
        tier
      );

    if (planTierClass) {
      membershipPlanNameElement.classList.add(
        planTierClass
      );
    }
  }

  const membershipStatusElement =
  document.getElementById(
    "membership-status"
  );

if (membershipStatusElement) {

  const isActive =
    hasActivePaidMembership(
      membership
    );

  membershipStatusElement.classList.remove(
    "status-green",
    "status-yellow",
    "status-red"
  );

  for (
    let tierNumber = 1;
    tierNumber <= 7;
    tierNumber += 1
  ) {
    membershipStatusElement.classList.remove(
      `customer-tier-status-${tierNumber}`
    );
  }

  if (isActive) {

    const tierStatusClass =
      customerTierStatusClass(
        tier
      );

    if (tierStatusClass) {
      membershipStatusElement.classList.add(
        tierStatusClass
      );
    } else {
      membershipStatusElement.classList.add(
        daysRemaining <= 7
          ? "status-yellow"
          : "status-green"
      );
    }

    membershipStatusElement.textContent =
      `â— ACTIVE â€” ${daysRemaining} ${
        daysRemaining === 1
          ? "day"
          : "days"
      } left`;

  } else {

    membershipStatusElement.classList.add(
      "status-red"
    );

    membershipStatusElement.textContent =
      `â— ${status.toUpperCase()}`;
  }
}

  setText(
    "membership-prim«ëŒ+Š×®º+º$zzb¥æ6R"À¢&–6UFW‡@¢“° ¢6WEFW‡B€¢&ÖVÖ&W'6†—×&öf–ÆW2"À¢&öf–ÆUFW‡@¢“° ¢6WEFW‡B€¢&ÖVÖ&W'6†—×W&–öBÖVæB"À¢FFUFW‡@¢“° ¢6WEFW‡B€¢&ÖVÖ&W'6†—ÖF—2×&VÖ–æ–ær"À¢F—5&VÖ–æ–æp¢“° ¢6WEFW‡B€¢&FWF–Â×Æâ"À¢ÆäæÖP¢“° ¢6WEFW‡B€¢&FWF–Â×7FGW2"À¢7FGW0¢“° ¢6WEFW‡B€¢&FWF–Â×&–6R"À¢&–6UFW‡@¢“° ¢6WEFW‡B€¢&FWF–Â×&öf–ÆW2"À¢&öf–ÆUFW‡@¢“° ¢6WEFW‡B€¢&FWF–Â×W&–öBÖVæB"À¢FFUFW‡@¢“° ¢6öç7BFW67&—F–öâĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&ÖVÖ&W'6†—ÖFW67&—F–öâ ¢“° ¢–b†FW67&—F–öâ’°¢–b€¢ÖVÖ&W'6†—æ6æ6VÄEW&–öDVæ@¢’°¢FW67&—F–öâçFW‡D6öçFVçBĞ¢W&–öDVæ@¢ò–÷W"ÖVÖ&W'6†——266†VGVÆVBFòVæBöâG¶f÷&ÖDFFR€¢W&–öDVæ@¢—Òæ ¢¢%–÷W"ÖVÖ&W'6†——266†VGVÆVBFò6æ6VÂBF†RVæBöbF†R7W'&VçB&–ÆÆ–ærW&–öBâ#°¢ÒVÇ6R°¢FW67&—F–öâçFW‡D6öçFVçBĞ¢%–÷W"ÖVÖ&W'6†—–æf÷&ÖF–öâ—26öææV7FVBFò–÷W"4Ä%2âu$%24ò7W7FöÖW"66÷VçBâ#°¢Ğ¢Ğ§Ğ  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢õ$DU"„•5Dõ%£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢4dTB4„•”ärDE$U54U2ò”ÔTåBÔUD„ôE0£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ  ¦gVæ7F–öâ&öf–ÆU6fVDFG&W74÷F–öç2€¢6VÆV7FVD–BÒ" ¢’°¢6öç7BFG&W76W2Ğ¢'&’æ—4'&’€¢7FFRç6fVDFWF–Ç0¢òæFG&W76W0¢¢ò7FFRç6fVDFWF–Ç0¢æFG&W76W0¢¢µÓ° ¢–b‚FG&W76W2æÆVæwF‚’°¢&WGW&â ¢Æ÷F–öâfÇVSÒ"#à¢æò6fVB6†—–ærFG&W76W0¢Âö÷F–öãà¢°¢Ğ ¢&WGW&â ¢Æ÷F–öâfÇVSÒ"#à¢6†ö÷6R6fVB6†—–æp¢Âö÷F–öãà¢G°¢FG&W76W0¢æÖ€¢€¢—FVÒÀ¢–æFW€¢’Óâ ¢Æ÷F–öà¢fÇVSÒ"G¶W66T‡FÖÂ€¢—FVÒæ–@¢—Ò ¢G°¢7G&–ær€¢—FVÒæ–@¢’ÓÓĞ¢7G&–ær€¢6VÆV7FVD–@¢¢ò'6VÆV7FVB ¢¢" ¢Ğ¢à¢G¶W66T‡FÖÂ€¢—FVÒæÆ&VÂÇÀ¢FG&W72G¶–æFW‚²Ö ¢—Ğ¢Âö÷F–öãà¢ ¢¢æ¦ö–â‚""¢Ğ¢°§Ğ  ¦gVæ7F–öâ&öf–ÆU6fVE–ÖVçD÷F–öç2€¢6VÆV7FVD–BÒ" ¢’°¢6öç7B–ÖVçG2Ğ¢'&’æ—4'&’€¢7FFRç6fVDFWF–Ç0¢òç–ÖVçDÖWF†öG0¢¢ò7FFRç6fVDFWF–Ç0¢ç–ÖVçDÖWF†öG0¢¢µÓ° ¢–b‚–ÖVçG2æÆVæwF‚’°¢&WGW&â ¢Æ÷F–öâfÇVSÒ"#à¢æò6fVB–ÖVçB6&G0¢Âö÷F–öãà¢°¢Ğ ¢&WGW&â ¢Æ÷F–öâfÇVSÒ"#à¢6†ö÷6R6fVB6&@¢Âö÷F–öãà¢G°¢–ÖVçG0¢æÖ€¢€¢—FVÒÀ¢–æFW€¢’Óâ ¢Æ÷F–öà¢fÇVSÒ"G¶W66T‡FÖÂ€¢—FVÒæ–@¢—Ò ¢G°¢7G&–ær€¢—FVÒæ–@¢’ÓÓĞ¢7G&–ær€¢6VÆV7FVD–@¢¢ò'6VÆV7FVB ¢¢" ¢Ğ¢à¢G¶W66T‡FÖÂ€¢—FVÒæ6&DÆ&VÂÇÀ¢6&BG¶–æFW‚²Ö ¢—ÒG°¢—FVÒæÖ6¶VDçVÖ&W ¢ò(	BG¶W66T‡FÖÂ€¢—FVÒæÖ6¶VDçVÖ&W ¢—Ö ¢¢" ¢Ğ¢Âö÷F–öãà¢ ¢¢æ¦ö–â‚""¢Ğ¢°§Ğ  ¦gVæ7F–öâ&öf–ÆU&VF–æW72€¢&öf–ÆRÀ¢6&@¢’°¢6öç7B&WV—&VE6†—–ærÒ°¢&f—'7DæÖR"À¢&Æ7DæÖR"À¢&FG&W72"À¢&6—G’"À¢'7FFR"À¢'¦—"À¢&6÷VçG'’ ¢Ó° ¢6öç7B6†—–æu&VG’Ğ¢&WV—&VE6†—–æræWfW'’€¢¶W’Óà¢&ööÆVâ€¢7G&–ær€¢&öf–ÆSòå¶¶W•ÒÇÀ¢" ¢’çG&–Ò‚¢¢“° ¢6öç7B&t6&BĞ¢7G&–ær€¢6&Còæ6ô6&DçVÖ&W"ÇÀ¢6&CòæÖ6¶VDçVÖ&W"ÇÀ¢" ¢“° ¢6öç7B6&DF–v—G2Ğ¢&t6&Bç&WÆ6R€¢õÄBörÀ¢" ¢“° ¢6öç7B†4Ö6¶VD6&BĞ¢&ööÆVâ€¢6&CòæÖ6¶VDçVÖ&W"b`¢6&DF–v—G2æÆVæwF‚ÓÓÒ@¢“° ¢6öç7B6&E&VG’Ğ¢&ööÆVâ€¢7G&–ær€¢6&Còæ6&F†öÆFW"ÇÀ¢" ¢’çG&–Ò‚¢’b`¢€¢õåÆG³"Ã—ÒBòçFW7B€¢6&DF–v—G0¢’ÇÀ¢†4Ö6¶VD6&@¢’b`¢õâƒ³Ó•×Ã³Ó%Ò’BòçFW7B€¢7G&–ær€¢6&CòæW‡ÖöçF‚ÇÀ¢" ¢¢’b`¢õåÆG³GÒBòçFW7B€¢7G&–ær€¢6&CòæW‡–V"ÇÀ¢" ¢¢“° ¢&WGW&â°¢&VG“ ¢6†—–æu&VG’b`¢6&E&VG’À¢6†—–æu&VG’À¢6&E&VG¢Ó°§Ğ   ¦gVæ7F–öâ&öf–ÆT6÷VçFF÷vä–æfò‡°¢W‡—&W4BÒçVÆÂÀ¢F—5&VÖ–æ–ærÒçVÆÂÀ¢7F—fRÒG'VRÀ¢–æFVf–æ—FRÒfÇ6P§ÒÒ·Ò’°¢–b€¢7F—fP¢’°¢&WGW&â°¢6Æ74æÖS¢&W‡—&VB"À¢Æ&VÃ¢$”ä5D•dR"À¢FWF–Ã¢$æ÷B7F—fR ¢Ó°¢Ğ ¢–b€¢–æFVf–æ—FRÇÀ¢W‡—&W4@¢’°¢&WGW&â°¢6Æ74æÖS¢'&VG’"À¢Æ&VÃ¢$5D•dR"À¢FWF–Ã¢$æòW‡—&F–öâ ¢Ó°¢Ğ ¢6öç7B†4W‡Æ–6—DF—2Ğ¢F—5&VÖ–æ–ærÓÒçVÆÂb`¢F—5&VÖ–æ–ærÓÒVæFVf–æVBb`¢7G&–ær€¢F—5&VÖ–æ–æp¢’çG&–Ò‚’ÓÒ""b`¢çVÖ&W"æ—4f–æ—FR€¢çVÖ&W"€¢F—5&VÖ–æ–æp¢¢“° ¢6öç7BF—2Ğ¢†4W‡Æ–6—DF—0¢òÖF‚æÖ‚€¢À¢çVÖ&W"€¢F—5&VÖ–æ–æp¢¢¢¢6Æ7VÆFTF—5&VÖ–æ–ær€¢W‡—&W4@¢“° ¢–b€¢F—2ÃÒ ¢’°¢&WGW&â°¢6Æ74æÖS¢&W‡—&VB"À¢Æ&VÃ¢$U…•$TB"À¢FWF–Ã ¢f÷&ÖDFFR€¢W‡—&W4@¢¢Ó°¢Ğ ¢&WGW&â°¢6Æ74æÖS ¢F—2ÃÒp¢ò'v&æ–ær ¢¢'&VG’"À ¢Æ&VÃ ¢$5D•dR"À ¢FWF–Ã ¢G¶F—7ÒG°¢F—2ÓÓÒ¢ò&F’ ¢¢&F—2 ¢ÒÆVgF ¢Ó°§Ğ  ¦gVæ7F–öâ&öf–ÆT6÷VçFF÷vä&FvT‡FÖÂ€¢–æfğ¢’°¢&WGW&â ¢ÆF—`¢6Æ73Ò'&öf–ÆRÖW‡—'’×7FGW2G°¢–æfòæ6Æ74æÖP¢Ò ¢à¢Ç7à¢6Æ73Ò'&öf–ÆRÖW‡—'’ÖÆ–v‡B ¢&–Ö†–FFVãÒ'G'VR ¢ãÂ÷7ãà ¢ÆF—cà¢Ç7G&öæsà¢G¶W66T‡FÖÂ€¢–æfòæÆ&VÀ¢—Ğ¢Â÷7G&öæsà ¢Ç6ÖÆÃà¢G¶W66T‡FÖÂ€¢–æfòæFWF–À¢—Ğ¢Â÷6ÖÆÃà¢ÂöF—cà¢ÂöF—cà¢°§Ğ  ¦gVæ7F–öâ&VF–æW74&FvT‡FÖÂ€¢&VF–æW70¢’°¢6öç7B&VG’Ğ¢&VF–æW73òç&VG’ÓÓÒG'VS° ¢&WGW&â ¢ÆF—`¢6Æ73Ò'&öf–ÆR×&VF–æW72G°¢&VG¢ò'&VG’ ¢¢&Ö—76–ær ¢Ò ¢à¢Ç7à¢6Æ73Ò'&öf–ÆR×&VF–æW72ÖÆ–v‡B ¢&–Ö†–FFVãÒ'G'VR ¢ãÂ÷7ãà ¢ÆF—cà¢Ç7G&öæsà¢G°¢&VG¢ò%$TE’ ¢¢$Ô•54”är”ädò ¢Ğ¢Â÷7G&öæsà ¢Ç6ÖÆÃà¢G°¢&VG¢ò%6†—–ærb6&B6ö×ÆWFR ¢¢€¢&VF–æW73òç6†—–æu&VG’b`¢&VF–æW73òæ6&E&VG¢ò%6†—–ærb6&BæVVFVB ¢¢&VF–æW73òç6†—–æu&VG¢ò%6†—–æræVVFVB ¢¢$6&BæVVFVB ¢¢Ğ¢Â÷6ÖÆÃà¢ÂöF—cà¢ÂöF—cà¢°§Ğ  ¦gVæ7F–öâ6fVDFG&W74'”–B†–B’°¢&WGW&â‡7FFRç6fVDFWF–Ç3òæFG&W76W2ÇÂµÒ’æf–æB€¢—FVÒÓâ7G&–ær†—FVÒæ–B’ÓÓÒ7G&–ær†–B¢’ÇÂçVÆÃ°§Ğ ¦gVæ7F–öâ6fVE–ÖVçD'”–B†–B’°¢&WGW&â‡7FFRç6fVDFWF–Ç3òç–ÖVçDÖWF†öG2ÇÂµÒ’æf–æB€¢—FVÒÓâ7G&–ær†—FVÒæ–B’ÓÓÒ7G&–ær†–B¢’ÇÂçVÆÃ°§Ğ ¦gVæ7F–öâ&VæFW%6fVDFWF–Ç4ÖævW"‚’°¢6öç7BFG&W76W2Ò'&’æ—4'&’‡7FFRç6fVDFWF–Ç3òæFG&W76W2¢ò7FFRç6fVDFWF–Ç2æFG&W76W0¢¢µÓ° ¢6öç7B–ÖVçG2Ò'&’æ—4'&’‡7FFRç6fVDFWF–Ç3òç–ÖVçDÖWF†öG2¢ò7FFRç6fVDFWF–Ç2ç–ÖVçDÖWF†öG0¢¢µÓ° ¢6öç7BFG&W756VÆV7BÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVBÖFG&W72×6VÆV7B"“°¢6öç7B–ÖVçE6VÆV7BÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVB×–ÖVçB×6VÆV7B"“° ¢6WEFW‡B‚'6fVBÖFG&W72Ö6÷VçB"ÂFG&W76W2æÆVæwF‚“°¢6WEFW‡B‚'6fVB×–ÖVçBÖ6÷VçB"Â–ÖVçG2æÆVæwF‚“° ¢–b†FG&W756VÆV7B’°¢6öç7B7W'&VçBÒFG&W756VÆV7BçfÇVS°¢FG&W756VÆV7Bæ–ææW$…DÔÂÒFG&W76W2æÆVæwF€¢òFG&W76W2æÖ‚†—FVÒÂ–æFW‚’Óâ ¢Æ÷F–öâfÇVSÒ"G¶W66T‡FÖÂ†—FVÒæ–B—Ò#à¢G¶W66T‡FÖÂ†—FVÒæÆ&VÂÇÂFG&W72G¶–æFW‚²Ö—Ğ¢Âö÷F–öãà¢’æ¦ö–â‚""¢¢Æ÷F–öâfÇVSÒ"#äæò6fVBFG&W76W3Âö÷F–öãæ° ¢–b†7W'&VçBbb6fVDFG&W74'”–B†7W'&VçB’’°¢FG&W756VÆV7BçfÇVRÒ7W'&VçC°¢Ğ¢Ğ ¢–b‡–ÖVçE6VÆV7B’°¢6öç7B7W'&VçBÒ–ÖVçE6VÆV7BçfÇVS°¢–ÖVçE6VÆV7Bæ–ææW$…DÔÂÒ–ÖVçG2æÆVæwF€¢ò–ÖVçG2æÖ‚†—FVÒÂ–æFW‚’Óâ ¢Æ÷F–öâfÇVSÒ"G¶W66T‡FÖÂ†—FVÒæ–B—Ò#à¢G¶W66T‡FÖÂ†—FVÒæ6&DÆ&VÂÇÂ–ÖVçBG¶–æFW‚²Ö—Ğ¢Âö÷F–öãà¢’æ¦ö–â‚""¢¢Æ÷F–öâfÇVSÒ"#äæò6fVB6&G3Âö÷F–öãæ° ¢–b†7W'&VçBbb6fVE–ÖVçD'”–B†7W'&VçB’’°¢–ÖVçE6VÆV7BçfÇVRÒ7W'&VçC°¢Ğ¢Ğ ¢&VæFW%6fVDFG&W75&Wf–Wr‚“°¢&VæFW%6fVE–ÖVçE&Wf–Wr‚“°§Ğ ¦gVæ7F–öâ&VæFW%6fVDFG&W75&Wf–Wr‚’°¢6öç7B–BÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVBÖFG&W72×6VÆV7B"“òçfÇVS°¢6öç7B—FVÒÒ6fVDFG&W74'”–B†–B“°¢6öç7B&Wf–WrÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVBÖFG&W72×&Wf–Wr"“°¢6öç7B7F–öç2ÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVBÖFG&W72ÖW†—7F–ærÖ7F–öç2"“°¢–b‚&Wf–Wr’&WGW&ã° ¢–b‚—FVÒ’°¢&Wf–Wræ–ææW$…DÔÂÒÇ6Æ73Ò&66÷VçBÖ×WFVB#äæò6fVB6†—–ærFG&W76W2–WBãÂ÷æ°¢–b†7F–öç2’7F–öç2æ†–FFVâÒG'VS°¢&WGW&ã°¢Ğ ¢6öç7BæÖRÒ¶—FVÒæf—'7DæÖRÂ—FVÒæÆ7DæÖUÒæf–ÇFW"„&ööÆVâ’æ¦ö–â‚""“°¢6öç7BÆ–æRÒ°¢—FVÒæFG&W72Â—FVÒæFG&W73"Â—FVÒæ6—G’À¢—FVÒç7FFRÂ—FVÒç¦—Â—FVÒæ6÷VçG'¢Òæf–ÇFW"„&ööÆVâ’æ¦ö–â‚"Â"“° ¢&Wf–Wræ–ææW$…DÔÂÒ ¢ÇãÇ7G&öæsâG¶W66T‡FÖÂ†—FVÒæÆ&VÂÇÂ%6fVBFG&W72"—ÓÂ÷7G&öæsãÂ÷à¢ÇâG¶W66T‡FÖÂ†æÖRÇÂ.(	B"—ÓÂ÷à¢ÇâG¶W66T‡FÖÂ†Æ–æRÇÂ.(	B"—ÓÂ÷à¢Ç6Æ73Ò&66÷VçBÖ×WFVB#å6÷W&6S¢G¶W66T‡FÖÂ…7G&–ær†—FVÒç6÷W&6RÇÂ'6fVB"’ç&WÆ6R‚õòörÂ""’—ÓÂ÷à¢° ¢–b†7F–öç2’7F–öç2æ†–FFVâÒfÇ6S°§Ğ ¦gVæ7F–öâ&VæFW%6fVE–ÖVçE&Wf–Wr‚’°¢6öç7B–BÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVB×–ÖVçB×6VÆV7B"“òçfÇVS°¢6öç7B—FVÒÒ6fVE–ÖVçD'”–B†–B“°¢6öç7B&Wf–WrÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVB×–ÖVçB×&Wf–Wr"“°¢6öç7B7F–öç2ÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVB×–ÖVçBÖW†—7F–ærÖ7F–öç2"“°¢–b‚&Wf–Wr’&WGW&ã° ¢–b‚—FVÒ’°¢&Wf–Wræ–ææW$…DÔÂÒÇ6Æ73Ò&66÷VçBÖ×WFVB#äæò6fVB–ÖVçB6&G2–WBãÂ÷æ°¢–b†7F–öç2’7F–öç2æ†–FFVâÒG'VS°¢&WGW&ã°¢Ğ ¢&Wf–Wræ–ææW$…DÔÂÒ ¢ÇãÇ7G&öæsâG¶W66T‡FÖÂ†—FVÒæ6&DÆ&VÂÇÂ%6fVB–ÖVçB"—ÓÂ÷7G&öæsãÂ÷à¢ÇâG¶W66T‡FÖÂ†—FVÒæ6&F†öÆFW"ÇÂ.(	B"—ÓÂ÷à¢Çä6&BçVÖ&W#¢Ç7G&öæsâG¶W66T‡FÖÂ†—FVÒæ6ô6&DçVÖ&W"ÇÂ—FVÒæ6&DçVÖ&W"ÇÂ—FVÒæÖ6¶VDçVÖ&W"ÇÂ.(	B"—ÓÂ÷7G&öæsãÂ÷à¢ÇäW‡—&W3¢G¶W66T‡FÖÂ…¶—FVÒæW‡ÖöçF‚Â—FVÒæW‡–V%Òæf–ÇFW"„&ööÆVâ’æ¦ö–â‚"ò"’ÇÂ.(	B"—ÓÂ÷à¢Çå6V7W&—G’6öFS¢Ç7G&öæsâG¶W66T‡FÖÂ†—FVÒç6V7W&—G”6öFRÇÂ.(	B"—ÓÂ÷7G&öæsãÂ÷à¢Ç6Æ73Ò&66÷VçBÖ×WFVB#å6÷W&6S¢G¶W66T‡FÖÂ…7G&–ær†—FVÒç6÷W&6RÇÂ'6fVB"’ç&WÆ6R‚õòörÂ""’—ÓÂ÷à¢° ¢–b†7F–öç2’7F–öç2æ†–FFVâÒfÇ6S°§Ğ ¦gVæ7F–öâf–ÆÅ6fVDFG&W74f÷&Ò†—FVÒÒçVÆÂ’°¢6öç7Bf÷&ÒÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVBÖFG&W72Öf÷&Ò"“°¢–b‚f÷&Ò’&WGW&ã°¢f÷&Òæ†–FFVâÒfÇ6S° ¢°¢&–B"Â&Æ&VÂ"Â&f—'7DæÖR"Â&Æ7DæÖR"Â&FG&W72"À¢&FG&W73""Â&6—G’"Â'7FFR"Â'¦—"Â&6÷VçG'’ ¢Òæf÷$V6‚†æÖRÓâ°¢–b†f÷&ÒæVÆVÖVçG5¶æÖUÒ’°¢f÷&ÒæVÆVÖVçG5¶æÖUÒçfÇVRÒ—FVÓòå¶æÖUÒÇÂ"#°¢Ğ¢Ò“°§Ğ ¦gVæ7F–öâf–ÆÅ6fVE–ÖVçDf÷&Ò†—FVÒÒçVÆÂ’°¢6öç7Bf÷&ÒÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVB×–ÖVçBÖf÷&Ò"“°¢–b‚f÷&Ò’&WGW&ã°¢f÷&Òæ†–FFVâÒfÇ6S° ¢–b†f÷&ÒæVÆVÖVçG2æ–B’f÷&ÒæVÆVÖVçG2æ–BçfÇVRÒ—FVÓòæ–BÇÂ"#°¢–b†f÷&ÒæVÆVÖVçG2æ6&DÆ&VÂ’f÷&ÒæVÆVÖVçG2æ6&DÆ&VÂçfÇVRÒ—FVÓòæ6&DÆ&VÂÇÂ"#°¢–b†f÷&ÒæVÆVÖVçG2æ6&F†öÆFW"’f÷&ÒæVÆVÖVçG2æ6&F†öÆFW"çfÇVRÒ—FVÓòæ6&F†öÆFW"ÇÂ"#°¢–b†f÷&ÒæVÆVÖVçG2æW‡ÖöçF‚’f÷&ÒæVÆVÖVçG2æW‡ÖöçF‚çfÇVRÒ—FVÓòæW‡ÖöçF‚ÇÂ"#°¢–b†f÷&ÒæVÆVÖVçG2æW‡–V"’f÷&ÒæVÆVÖVçG2æW‡–V"çfÇVRÒ—FVÓòæW‡–V"ÇÂ"#° ¢–b†f÷&ÒæVÆVÖVçG2æ6ô6&DçVÖ&W"’°¢f÷&ÒæVÆVÖVçG2æ6ô6&DçVÖ&W"çfÇVRÒ"#°¢f÷&ÒæVÆVÖVçG2æ6ô6&DçVÖ&W"ç&WV—&VBÒ—FVÓ°¢f÷&ÒæVÆVÖVçG2æ6ô6&DçVÖ&W"çÆ6V†öÆFW"Ò—FVĞ¢ò$ÆVfR&Ææ²Fò¶VWW†—7F–ær6&B ¢¢$VçFW"6&BçVÖ&W"#°¢Ğ ¢–b†f÷&ÒæVÆVÖVçG2ç6V7W&—G”6öFR’°¢f÷&ÒæVÆVÖVçG2ç6V7W&—G”6öFRçfÇVRÒ"#°¢Ğ§Ğ  ¦gVæ7F–öâ6WGW6fVDFWF–Ç466÷&F–öç2‚’°¢Fö7VÖVç@¢çVW'•6VÆV7F÷$ÆÂ€¢"ç6fVBÖFWF–Ç2ÖÖævW"ç6fVBÖFWF–Â×æVÂ ¢¢æf÷$V6‚€¢€¢æVÂÀ¢–æFW€¢’Óâ°¢–b€¢æVÂæFF6W@¢æ66÷&F–öå&VG’ÓÓĞ¢'G'VR ¢’°¢&WGW&ã°¢Ğ ¢æVÂæFF6W@¢æ66÷&F–öå&VG’Ğ¢'G'VR#° ¢6öç7B†VBĞ¢æVÂçVW'•6VÆV7F÷"€¢"ç6fVBÖFWF–ÂÖ†VB ¢“° ¢–b‚†VB’°¢&WGW&ã°¢Ğ ¢6öç7BF—FÆRĞ¢†VBçVW'•6VÆV7F÷"€¢&ƒB ¢“° ¢–b‡F—FÆR’°¢F—FÆRçFW‡D6öçFVçBĞ¢–æFW‚ÓÓÒ ¢ò$W‡G&6†—–ærFG&W76W2 ¢¢$W‡G&–ÖVçG2#°¢Ğ ¢6öç7B&öG’Ğ¢Fö7VÖVçBæ7&VFTVÆVÖVçB€¢&F—b ¢“° ¢&öG’æ6Æ74æÖRĞ¢'6fVBÖFWF–ÂÖ66÷&F–öâÖ&öG’#° ¢&öG’æ†–FFVâÒG'VS° ¢ÆWBæöFRĞ¢†VBææW‡E6–&Æ–æs° ¢v†–ÆR†æöFR’°¢6öç7BæW‡BĞ¢æöFRææW‡E6–&Æ–æs° ¢&öG’æVæD6†–ÆB€¢æöFP¢“° ¢æöFRÒæW‡C°¢Ğ ¢æVÂæVæD6†–ÆB€¢&öG¢“° ¢†VBæ6Æ74Æ—7BæFB€¢'6fVBÖFWF–Â×FövvÆR ¢“° ¢†VBç6WDGG&–'WFR€¢'&öÆR"À¢&'WGFöâ ¢“° ¢†VBç6WDGG&–'WFR€¢'F&–æFW‚"À¢# ¢“° ¢†VBç6WDGG&–'WFR€¢&&–ÖW‡æFVB"À¢&fÇ6R ¢“° ¢6öç7B÷Vä†–çBĞ¢Fö7VÖVçBæ7&VFTVÆVÖVçB€¢'7â ¢“° ¢÷Vä†–çBæ6Æ74æÖRĞ¢'6fVBÖFWF–ÂÖ÷VâÖ†–çB#° ¢÷Vä†–çBçFW‡D6öçFVçBĞ¢–æFW‚ÓÓÒ ¢ò$õTâ4„•”är ¢¢$õTâ”ÔTåE2#° ¢6öç7B&–v‡D6öçG&öÂĞ¢Fö7VÖVçBæ7&VFTVÆVÖVçB€¢'7â ¢“° ¢&–v‡D6öçG&öÂæ6Æ74æÖRĞ¢'6fVBÖFWF–Â×&–v‡BÖ6öçG&öÂ#° ¢&–v‡D6öçG&öÂæVæD6†–ÆB€¢÷Vä†–ç@¢“° ¢6öç7B6†Wg&öâĞ¢Fö7VÖVçBæ7&VFTVÆVÖVçB€¢'7â ¢“° ¢6†Wg&öâæ6Æ74æÖRĞ¢'6fVBÖFWF–ÂÖ6†Wg&öâ#° ¢6†Wg&öâçFW‡D6öçFVçBĞ¢.)kâ#° ¢&–v‡D6öçG&öÂæVæD6†–ÆB€¢6†Wg&öà¢“° ¢†VBæVæD6†–ÆB€¢&–v‡D6öçG&öÀ¢“° ¢6öç7BFövvÆRÒ‚’Óâ°¢6öç7B÷Væ–ærĞ¢&öG’æ†–FFVã° ¢&öG’æ†–FFVâĞ¢÷Væ–æs° ¢æVÂæ6Æ74Æ—7BçFövvÆR€¢&W‡æFVB"À¢÷Væ–æp¢“° ¢†VBç6WDGG&–'WFR€¢&&–ÖW‡æFVB"À¢÷Væ–æp¢ò'G'VR ¢¢&fÇ6R ¢“° ¢÷Vä†–çBçFW‡D6öçFVçBĞ¢–æFW‚ÓÓÒ ¢ò€¢÷Væ–æp¢ò$4Äõ4R4„•”är ¢¢$õTâ4„•”är ¢¢¢€¢÷Væ–æp¢ò$4Äõ4R”ÔTåE2 ¢¢$õTâ”ÔTåE2 ¢“°¢Ó° ¢†VBæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢FövvÆP¢“° ¢†VBæFDWfVçDÆ—7FVæW"€¢&¶W–F÷vâ"À¢WfVçBÓâ°¢–b€¢WfVçBæ¶W’ÓÓĞ¢$VçFW""ÇÀ¢WfVçBæ¶W’ÓÓĞ¢" ¢’°¢WfVçBç&WfVçDFVfVÇB‚“°¢FövvÆR‚“°¢Ğ¢Ğ¢“°¢Ğ¢“°§Ğ  ¦7–æ2gVæ7F–öâÆöE6fVDFWF–Ç2‚’°¢–b‚7FFRæ7W7FöÖW"’&WGW&ã° ¢–b€¢DÔ”åõ$Ud”UuôÔôDP¢’°¢&VæFW%6fVDFWF–Ç4ÖævW"‚“°¢6WGW6fVDFWF–Ç466÷&F–öç2‚“°¢&VæFW%&WF–ÆW%&öf–ÆW2‚“°¢&WGW&ã°¢Ğ ¢G'’°¢6öç7B&W7öç6RÒv—BfWF6‚‚"ö’ö66÷VçB÷6fVBÖFWF–Ç2"Â°¢7&VFVçF–Ç3¢'6ÖRÖ÷&–v–â"À¢66†S¢&æò×7F÷&R ¢Ò“° ¢6öç7BFFÒv—B&VD§6öâ‡&W7öç6R“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"†FFæW'&÷"ÇÂ%Væ&ÆRFòÆöB6fVB6†V6¶÷WBFWF–Ç2â"“°¢Ğ ¢7FFRç6fVDFWF–Ç2Ò°¢FG&W76W3¢'&’æ—4'&’†FFæFG&W76W2’òFFæFG&W76W2¢µÒÀ¢–ÖVçDÖWF†öG3¢'&’æ—4'&’†FFç–ÖVçDÖWF†öG2’òFFç–ÖVçDÖWF†öG2¢µĞ¢Ó° ¢&VæFW%6fVDFWF–Ç4ÖævW"‚“° ¢6WGW6fVDFWF–Ç466÷&F–öç2‚“° ¢&VæFW%&WF–ÆW%&öf–ÆW2‚“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚%6fVB6†V6¶÷WBFWF–Ç2ÆöBf–ÆVC¢"ÂW'&÷"“°¢Ğ§Ğ ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVBÖFG&W72×6VÆV7B"¢òæFDWfVçDÆ—7FVæW"‚&6†ævR"Â&VæFW%6fVDFG&W75&Wf–Wr“° ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVB×–ÖVçB×6VÆV7B"¢òæFDWfVçDÆ—7FVæW"‚&6†ævR"Â&VæFW%6fVE–ÖVçE&Wf–Wr“° ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚&FB×6fVBÖFG&W72"¢òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâf–ÆÅ6fVDFG&W74f÷&Ò‚’“° ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚&FB×6fVB×–ÖVçB"¢òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâf–ÆÅ6fVE–ÖVçDf÷&Ò‚’“° ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚&VF—B×6fVBÖFG&W72"¢òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ°¢6öç7B–BÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVBÖFG&W72×6VÆV7B"“òçfÇVS°¢f–ÆÅ6fVDFG&W74f÷&Ò‡6fVDFG&W74'”–B†–B’“°¢Ò“° ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚&VF—B×6fVB×–ÖVçB"¢òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ°¢6öç7B–BÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVB×–ÖVçB×6VÆV7B"“òçfÇVS°¢f–ÆÅ6fVE–ÖVçDf÷&Ò‡6fVE–ÖVçD'”–B†–B’“°¢Ò“° ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚&6æ6VÂ×6fVBÖFG&W72"¢òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ°¢6öç7Bf÷&ÒÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVBÖFG&W72Öf÷&Ò"“°¢–b†f÷&Ò’f÷&Òæ†–FFVâÒG'VS°¢Ò“° ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚&6æ6VÂ×6fVB×–ÖVçB"¢òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ°¢6öç7Bf÷&ÒÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVB×–ÖVçBÖf÷&Ò"“°¢–b†f÷&Ò’f÷&Òæ†–FFVâÒG'VS°¢Ò“° ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVBÖFG&W72Öf÷&Ò"¢òæFDWfVçDÆ—7FVæW"‚'7V&Ö—B"Â7–æ2WfVçBÓâ°¢WfVçBç&WfVçDFVfVÇB‚“°¢6öç7Bf÷&ÒÒWfVçBæ7W'&VçEF&vWC°¢6öç7B–BÒ7G&–ær†f÷&ÒæVÆVÖVçG2æ–CòçfÇVRÇÂ""’çG&–Ò‚“°¢6öç7B&öG’Òö&¦V7Bæg&öÔVçG&–W2†æWrf÷&ÔFF†f÷&Ò’æVçG&–W2‚’“°¢FVÆWFR&öG’æ–C° ¢6öç7B&W7öç6RÒv—BfWF6‚€¢–@¢òö’ö66÷VçB÷6†—–ærÖFG&W76W2òG¶Væ6öFUU$”6ö×öæVçB†–B—Ö ¢¢"ö’ö66÷VçB÷6†—–ærÖFG&W76W2"À¢°¢ÖWF†öC¢–Bò%UB"¢%õ5B"À¢7&VFVçF–Ç3¢'6ÖRÖ÷&–v–â"À¢†VFW'3¢²$6öçFVçBÕG—R#¢&Æ–6F–öâö§6öâ"ÒÀ¢&öG“¢¥4ôâç7G&–æv–g’†&öG’¢Ğ¢“° ¢6öç7BFFÒv—B&VD§6öâ‡&W7öç6R“°¢6öç7BÖW76vRÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVBÖFWF–Ç2ÖÖW76vR"“° ¢–b‚&W7öç6Ræö²’°¢6WDÖW76vR†ÖW76vRÂFFæW'&÷"ÇÂ%Væ&ÆRFò6fRFG&W72â"Â&W'&÷""“°¢&WGW&ã°¢Ğ ¢f÷&Òæ†–FFVâÒG'VS°¢v—BÆöE6fVDFWF–Ç2‚“°¢6WDÖW76vR†ÖW76vRÂFFæÖW76vRÇÂ$FG&W726fVBâ"Â'7V66W72"“°¢Ò“° ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚'6fVB×–ÖVçBÖf÷&Ò"¢òæFDWfVçDÆ—7FVæW"‚'7V&Ö—B"Â7–æ2U¶¬{®0®+^zºè¬è‘ééŠ—¶ent => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = String(form.elements.id?.value || "").trim();
    const body = Object.fromEntries(new FormData(form).entries());
    delete body.id;

    const response = await fetch(
      id
        ? `/api/account/payment-methods/${encodeURIComponent(id)}`
        : "/api/account/payment-methods",
      {
        method: id ? "PUT" : "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

    const data = await readJson(response);
    const message = document.getElementById("saved-details-message");

    if (!response.ok) {
      setMessage(message, data.error || "Unable to save payment card.", "error");
      return;
    }

    form.hidden = true;
    await loadSavedDetails();
    setMessage(message, data.message || "Payment card saved.", "success");
  });

document.getElementById("delete-saved-address")
  ?.addEventListener("click", async () => {
    const id = document.getElementById("saved-address-select")?.value;
    if (!id || !confirm("Delete this saved shipping address?")) return;

    const response = await fetch(
      `/api/account/shipping-addresses/${encodeURIComponent(id)}`,
      { method: "DELETE", credentials: "same-origin" }
    );

    const data = await readJson(response);
    const message = document.getElementById("saved-details-message");

    if (!response.ok) {
      setMessage(message, data.error || "Unable to delete address.", "error");
      return;
    }

    await loadSavedDetails();
    setMessage(message, data.message || "Address deleted.", "success");
  });

document.getElementById("delete-saved-payment")
  ?.addEventListener("click", async () => {
    const id = document.getElementById("saved-payment-select")?.value;
    if (!id || !confirm("Delete this saved payment card?")) return;

    const response = await fetch(
      `/api/account/payment-methods/${encodeURIComponent(id)}`,
      { method: "DELETE", credentials: "same-origin" }
    );

    const data = await readJson(response);
    const message = document.getElementById("saved-details-message");

    if (!response.ok) {
      setMessage(message, data.error || "Unable to delete payment card.", "error");
      return;
    }

    await loadSavedDetails();
    setMessage(message, data.message || "Payment card deleted.", "success");
  });


function renderOrders(
  orders
) {
  const container =
    document.getElementById(
      "customer-orders"
    );

  if (!container) return;

  if (
    !Array.isArray(orders) ||
    orders.length === 0
  ) {
    container.innerHTML = `
      <div class="member-empty">

        <h3>
          No linked orders yet.
        </h3>

        <p>
          New purchases made while signed
          in will appear here automatically.
          You can also link an older order
          below.
        </p>

      </div>
    `;

    return;
  }

  container.innerHTML =
    orders
      .map(order => {
        const orderNumber =
          getOrderNumber(order);

        const tier =
          Number(order.tier);

        const localPlan =
          PLANS[tier] || null;

        const planName =
          order.planName ||
          localPlan?.name ||
          "Membership";

        const amount =
          order.amount ??
          localPlan?.amount ??
          null;

        const profiles =
          order.profiles ??
          localPlan?.profiles ??
          null;

        const orderDate =
          order.paidAt ||
          order.createdAt ||
          null;

        const endDate =
          order.subscriptionEndDate ||
          order.currentPeriodEnd ||
          order.cancelAt ||
          null;

        const status =
          normalizeStatus(
            order.status
          );

        return `
          <article class="customer-order">

            <div class="customer-order-head">

              <div>

                <span class="eyebrow">
                  ORDER
                </span>

                <h3>
                  ${escapeHtml(
                    orderNumber ||
                    "Order"
                  )}
                </h3>

              </div>

              <span class="membership-status">
                ${escapeHtml(status)}
              </span>

            </div>

            <div class="account-detail-list">

              <div>
                <span>Membership</span>
                <strong>
                  ${escapeHtml(
                    planName
                  )}
                </strong>
              </div>

              <div>
                <span>Monthly Price</span>
                <strong>
                  ${
                    amount != null
                      ? `$${escapeHtml(
                          amount
                        )}/month`
                      : "â€”"
                  }
                </strong>
              </div>

              <div>
                <span>ACO Profiles</span>
                <strong>
                  ${
                    profiles != null
                      ? escapeHtml(
                          profiles
                        )
                      : "â€”"
                  }
                </strong>
              </div>

              <div>
                <span>Order Date</span>
                <strong>
                  ${
                    orderDate
                      ? escapeHtml(
                          formatDate(
                            orderDate
                          )
                        )
                      : "â€”"
                  }
                </strong>
              </div>

              <div>
                <span>
                  Renewal / End Date
                </span>

                <strong>
                  ${
                    endDate
                      ? escapeHtml(
                          formatDate(
                            endDate
                          )
                        )
                      : "â€”"
                  }
                </strong>
              </div>

              ${
                order.updatedAt
                  ? `
                    <div>
                      <span>
                        Last Updated
                      </span>

                      <strong>
                        ${escapeHtml(
                          formatDate(
                            order.updatedAt
                          )
                        )}
                      </strong>
                    </div>
                  `
                  : ""
              }

            </div>

          </article>
        `;
      })
      .join("");
}


/* =====================================================
   EDIT ORDER SELECT
===================================================== */

function populateEditOrderSelect(
  orders
) {
  const select =
    document.getElementById(
      "edit-order-select"
    );

  const form =
    document.getElementById(
      "edit-order-form"
    );

  if (!select) return;

  select.innerHTML = `
    <option value="">
      Select an order
    </option>
  `;

  if (
    !Array.isArray(orders) ||
    orders.length === 0
  ) {
    if (form) {
      form.hidden = true;
    }

    return;
  }

  orders.forEach(order => {
    const orderNumber =
      getOrderNumber(order);

    if (!orderNumber) return;

    const option =
      document.createElement(
        "option"
      );

    option.value =
      orderNumber;

    option.textContent =
      `${orderNumber} â€” ${
        order.planName ||
        "Membership"
      }`;

    select.appendChild(
      option
    );
  });
}


function findOrder(
  orderNumber
) {
  return state.orders.find(
    order =>
      getOrderNumber(order) ===
      orderNumber
  );
}


function fillEditOrderForm(
  order
) {
  const form =
    document.getElementById(
      "edit-order-form"
    );

  if (!form) return;

  if (!order) {
    form.hidden = true;
    return;
  }

  form.hidden = false;

  const profile =
    getOrderProfile(order);

  const fields = [
    "profileName",
    "firstName",
    "lastName",
    "email",
    "phone",
    "address",
    "address2",
    "country",
    "state",
    "city",
    "zip"
  ];

  fields.forEach(name => {
    const input =
      form.elements[name];

    if (!input) return;

    input.value =
      profile[name] || "";
  });

  [
    "acoEmail",
    "acoPassword",
    "cardLabel",
    "cardholder",
    "acoCardNumber",
    "expMonth",
    "expYear"
  ].forEach(name => {
    const input =
      form.elements[name];

    if (input) {
      input.value = "";
    }
  });

  form.dataset.orderNumber =
    getOrderNumber(order);

  setMessage(
    document.getElementById(
      "edit-order-message"
    ),
    ""
  );
}


document
  .getElementById(
    "edit-order-select"
  )
  ?.addEventListener(
    "change",
    event => {
      const orderNumber =
        event.currentTarget.value;

      fillEditOrderForm(
        findOrder(orderNumber)
      );
    }
  );


/* =====================================================
   SAVE CUSTOMER ORDER CHANGES
===================================================== */

const editOrderForm =
  document.getElementById(
    "edit-order-form"
  );


editOrderForm?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const form =
      event.currentTarget;

    const orderNumber =
      form.dataset.orderNumber;

    const message =
      document.getElementById(
        "edit-order-message"
      );

    const button =
      form.querySelector(
        'button[type="submit"]'
      );

    if (!orderNumber) {
      setMessage(
        message,
        "Select an order first.",
        "error"
      );

      return;
    }

    const all =
      Object.fromEntries(
        new FormData(
          form
        ).entries()
      );

    const profile = {
      profileName:
        all.profileName || "",

      firstName:
        all.firstName || "",

      lastName:
        all.lastName || "",

      email:
        all.email || "",

      phone:
        all.phone || "",

      address:
        all.address || "",

      address2:
        all.address2 || "",

      country:
        all.country || "",

      state:
        all.state || "",

      city:
        all.city || "",

      zip:
        all.zip || ""
    };

    const secrets = {};

    const replacementAcoEmail =
      String(
        all.acoEmail || ""
      ).trim();

    const replacementPassword =
      String(
        all.acoPassword || ""
      );

    const cardLabel =
      String(
        all.cardLabel || ""
      ).trim();

    const cardholder =
      String(
        all.cardholder || ""
      ).trim();

    const cardNumber =
      String(
        all.acoCardNumber || ""
      )
        .replace(/\D/g, "");

    const expMonth =
      String(
        all.expMonth || ""
      ).trim();

    const expYear =
      String(
        all.expYear || ""
      ).trim();

    if (replacementAcoEmail) {
      secrets.acoEmail =
        replacementAcoEmail;
    }

    if (replacementPassword) {
      secrets.acoPassword =
        replacementPassword;
    }

    const anyCardField =
      Boolean(
        cardLabel ||
        cardholder ||
        cardNumber ||
        expMonth ||
        expYear
      );

    if (anyCardField) {
      if (
        !cardLabel ||
        !cardholder ||
        !cardNumber ||
        !expMonth ||
        !expYear
      ) {
        setMessage(
          message,
          "To replace the ACO card, complete all card replacement fields.",
          "error"
        );

        return;
      }

      secrets.cardLabel =
        cardLabel;

      secrets.cardholder =
        cardholder;

      secrets.acoCardNumber =
        cardNumber;

      secrets.expMonth =
        expMonth;

      secrets.expYear =
        expYear;
    }

    try {
      setButtonBusy(
        button,
        true,
        "Savingâ€¦"
      );

      setMessage(
        message,
        ""
      );

      const response =
        await fetch(
          `/api/account/orders/${encodeURIComponent(
            orderNumber
          )}`,
          {
            method: "PUT",

            headers: {
              "Content-Type":
                "application/json"
            },

            credentials:
              "same-origin",

            body:
              JSON.stringify({
                profile,
                secrets
              })
          }
        );

      const result =
        await readJson(
          response
        );

      if (!response.ok) {
        throw new Error(
          result.error ||
          "Unable to save your changes."
        );
      }

      setMessage(
        message,
        result.message ||
        "Your order information has been updated.",
        "success"
      );

      await loadMemberProfile(
        true
      );

      const select =
        document.getElementById(
          "edit-order-select"
        );

      if (select) {
        select.value =
          orderNumber;

        fillEditOrderForm(
          findOrder(
            orderNumber
          )
        );
      }

    } catch (error) {
      setMessage(
        message,
        error.message,
        "error"
      );

    } finally {
      setButtonBusy(
        button,
        false
      );
    }
  }
);


/* =====================================================
   UPGRADE MEMBERSHIP
===================================================== */

async function upgradeMembershipToTier(
  tier
) {
  const targetPlan =
    PLANS[tier];

  const currentTier =
    Number(
      state.membership?.tier ||
      0
    );

  if (!targetPlan) {
    return;
  }

  if (!currentTier) {
    window.alert(
      "Your current membership could not be identified. Please refresh My Profile and try again."
    );

    return;
  }

  if (
    tier ===
    currentTier
  ) {
    window.alert(
      `You are already on the ${targetPlan.name} membership.`
    );

    return;
  }

  if (
    tier <
    currentTier
  ) {
    window.alert(
      "This option is for upgrades only. Downgrades will be handled separately."
    );

    return;
  }

  const currentPlan =
    PLANS[currentTier];

  const confirmed =
    window.confirm(
      `Upgrade from ${currentPlan?.name || "your current membership"} to ${targetPlan.name}?\n\n` +
      `New monthly price: $${targetPlan.amount}/month\n` +
      `ACO profiles: ${targetPlan.profiles}\n\n` +
      "Stripe will immediately calculate and charge only the prorated difference for the remaining time in your current billing period. Your normal renewal date will stay the same."
    );

  if (!confirmed) {
    return;
  }

  const matchingButtons =
    Array.from(
      document.querySelectorAll(
        `[data-select="${tier}"]`
      )
    );

  try {
    matchingButtons.forEach(
      button => {
        setButtonBusy(
          button,
          true,
          "Upgradingâ€¦"
        );
      }
    );

    const response =
      await fetch(
        "/api/account/membership/upgrade",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          credentials:
            "same-origin",

          body:
            JSON.stringify({
              tier
            })
        }
      );

    const result =
      await readJson(
        response
      );

    if (!response.ok) {
      throw new Error(
        result.error ||
        "Unable to upgrade your membership."
      );
    }

    state.upgradeMode =
      false;

    clearSelectedTier();

    await loadMemberProfile(
      true
    );

    updatePricingUpgradeButtons();

    go(
      "my-profile"
    );

    showAccountMessage(
      result.message ||
      `Your membership has been upgraded to ${targetPlan.name}.`,
      "success"
    );

  } catch (error) {
    window.alert(
      error.message ||
      "The membership could not be upgraded."
    );

  } finally {
    matchingButtons.forEach(
      button => {
        setButtonBusy(
          button,
          false
        );
      }
    );

    updatePricingUpgradeButtons();
  }
}


document
  .getElementById(
    "upgrade-membership"
  )
  ?.addEventListener(
    "click",
    () => {
      const currentTier =
        Number(
          state.membership?.tier ||
          0
        );

      if (!currentTier) {
        state.upgradeMode =
          false;

        clearSelectedTier();

        updatePricingUpgradeButtons();

        go(
          "pricing"
        );

        return;
      }

      if (
        currentTier >= 7
      ) {
        showAccountMessage(
          "You already have the highest membership tier.",
          "info"
        );

        return;
      }

      state.upgradeMode =
        true;

      clearSelectedTier();

      updatePricingUpgradeButtons();

      go(
        "pricing"
      );
    }
  );

/* =====================================================
   RETAILER PROFILES
===================================================== */

const RETAILERS = [
  {
    key: "target",
    name: "Target"
  },
  {
    key: "walmart",
    name: "Walmart"
  },
  {
    key: "pkc",
    name: "PKC"
  },
  {
    key: "samsClub",
    name: "Sam's Club"
  },
  {
    key: "costco",
    name: "Costco"
  }
];


function getRetailerProfileBySlot(
  slot
) {
  return (
    state.retailerProfiles.find(
      profile =>
        Number(profile.slot) ===
        Number(slot)
    ) || null
  );
}


function retailerPasswordStatus(
  configured
) {
  return configured
    ? `
      <span
        class="retailer-password-status saved"
      >
        âœ“ Password saved
      </span>
    `
    : `
      <span
        class="retailer-password-status"
      >
        No password saved
      </span>
    `;
}


function retailerFieldsHtml(
  retailer,
  savedRetailer = {}
) {
  const username =
    savedRetailer.username || "";

  const isPkc =
    retailer.key ===
    "pkc";

  if (isPkc) {
    return `
      <div
        class="retailer-credential-card retailer-credential-card-pkc"
        data-retailer="${escapeHtml(
          retailer.key
        )}"
      >
        <div class="retailer-credential-heading">
          <div>
            <h4>
              ${escapeHtml(
                retailer.name
              )}
            </h4>

            <p>
              Enter the Pokem«ëŒ+Š×®º+º$zzb¥æÖöâ6VçFW"Æöv–âW6VBf÷"F†—2&öf–ÆRà¢Â÷à¢ÂöF—cà ¢Ç7â6Æ73Ò'&WF–ÆW"×77v÷&B×7FGW26fVB¶2ÖwVW7BÖ6†V6¶÷WBÖ&FvR#à¢55tõ$Bd”Ä$ÄRdõ"U…õ%@¢Â÷7ãà¢ÂöF—cà ¢ÆF—b6Æ73Ò'&WF–ÆW"Ö7&VFVçF–ÂÖf–VÆG2#à¢ÆÆ&VÃà¢VÖ–À ¢Æ–çW@¢G—SÒ&VÖ–Â ¢æÖSÒ"G¶W66T‡FÖÂ€¢&WF–ÆW"æ¶W¢—ÕW6W&æÖR ¢fÇVSÒ"G¶W66T‡FÖÂ€¢W6W&æÖP¢—Ò ¢WFö6ö×ÆWFSÒ&VÖ–Â ¢Ö†ÆVæwFƒÒ##SB ¢Æ6V†öÆFW#Ò%ö¶VÖöâ6VçFW"wVW7B6†V6¶÷WBVÖ–Â ¢à¢ÂöÆ&VÃà ¢ÆÆ&VÃà¢77v÷&@ ¢ÆF—b6Æ73Ò'&WF–ÆW"×77v÷&BÖ–çWB×w&#à¢Æ–çW@¢G—SÒ'77v÷&B ¢æÖSÒ"G¶W66T‡FÖÂ‡&WF–ÆW"æ¶W’—Õ77v÷&B ¢fÇVSÒ"G¶W66T‡FÖÂ…7G&–ær‡6fVE&WF–ÆW"ç77v÷&BÇÂ""’—Ò ¢WFö6ö×ÆWFSÒ&öfb ¢Ö†ÆVæwFƒÒ#S" ¢Æ6V†öÆFW#Ò$VçFW"ö¶VÖöâ6VçFW"77v÷&B ¢FFÖ7W7FöÖW"×6Vç6—F—fRÖ–çW@¢à ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'&WF–ÆW"×77v÷&B×FövvÆR ¢FF×&WF–ÆW"×77v÷&B×FövvÆP¢&–ÖÆ&VÃÒ%6†÷r77v÷&B ¢à¢6†÷p¢Âö'WGFöãà¢ÂöF—cà¢ÂöÆ&VÃà¢ÂöF—cà¢ÂöF—cà¢°¢Ğ ¢6öç7B6fVE77v÷&BĞ¢7G&–ær€¢6fVE&WF–ÆW"ç77v÷&BÇÀ¢" ¢“° ¢6öç7B77v÷&D6öæf–wW&VBĞ¢&ööÆVâ€¢6fVE&WF–ÆW"ç77v÷&D6öæf–wW&VBÇÀ¢6fVE77v÷&@¢“° ¢&WGW&â ¢ÆF—`¢6Æ73Ò'&WF–ÆW"Ö7&VFVçF–ÂÖ6&B ¢FF×&WF–ÆW#Ò"G¶W66T‡FÖÂ€¢&WF–ÆW"æ¶W¢—Ò ¢à ¢ÆF—`¢6Æ73Ò'&WF–ÆW"Ö7&VFVçF–ÂÖ†VF–ær ¢à¢ÆF—cà¢ÆƒCà¢G¶W66T‡FÖÂ€¢&WF–ÆW"ææÖP¢—Ğ¢ÂöƒCà ¢Çà¢VçFW"F†RÆöv–âW6VBf÷"F†—0¢&WF–ÆW"66÷VçBà¢Â÷à¢ÂöF—cà ¢G·&WF–ÆW%77v÷&E7FGW2€¢77v÷&D6öæf–wW&V@¢—Ğ¢ÂöF—cà ¢ÆF—`¢6Æ73Ò'&WF–ÆW"Ö7&VFVçF–ÂÖf–VÆG2 ¢à ¢ÆÆ&VÃà¢W6W&æÖRòVÖ–À ¢Æ–çW@¢G—SÒ'FW‡B ¢æÖSÒ"G¶W66T‡FÖÂ€¢&WF–ÆW"æ¶W¢—ÕW6W&æÖR ¢fÇVSÒ"G¶W66T‡FÖÂ€¢W6W&æÖP¢—Ò ¢WFö6ö×ÆWFSÒ&öfb ¢Ö†ÆVæwFƒÒ##SB ¢Æ6V†öÆFW#Ò"G¶W66T‡FÖÂ€¢&WF–ÆW"ææÖP¢—ÒW6W&æÖR÷"VÖ–Â ¢à¢ÂöÆ&VÃà ¢ÆÆ&VÃà¢G°¢77v÷&D6öæf–wW&V@¢ò%&WÆ6R77v÷&B ¢¢%77v÷&B ¢Ğ ¢ÆF—`¢6Æ73Ò'&WF–ÆW"×77v÷&BÖ–çWB×w& ¢à¢Æ–çW@¢G—SÒ'77v÷&B ¢æÖSÒ"G¶W66T‡FÖÂ€¢&WF–ÆW"æ¶W¢—Õ77v÷&B ¢fÇVSÒ"G¶W66T‡FÖÂ€¢6fVE77v÷&@¢—Ò ¢WFö6ö×ÆWFSÒ&öfb ¢Ö†ÆVæwFƒÒ#S" ¢Æ6V†öÆFW#Ò"G°¢77v÷&D6öæf–wW&V@¢ò%6fVB77v÷&B ¢¢VçFW"G¶W66T‡FÖÂ€¢&WF–ÆW"ææÖP¢—Ò77v÷&F ¢Ò ¢FFÖ7W7FöÖW"×6Vç6—F—fRÖ–çW@¢à ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'&WF–ÆW"×77v÷&B×FövvÆR ¢FF×&WF–ÆW"×77v÷&B×FövvÆP¢&–ÖÆ&VÃÒ%6†÷r77v÷&B ¢à¢6†÷p¢Âö'WGFöãà¢ÂöF—cà¢ÂöÆ&VÃà ¢ÂöF—cà ¢ÂöF—cà¢°§Ğ  ¦gVæ7F–öâ&öf–ÆT7F—fF–öä&FvT‡FÖÂ€¢7FGW0¢’°¢6öç7BfÇVRĞ¢7G&–ær€¢7FGW2ÇÀ¢&–æ6ö×ÆWFR ¢¢çG&–Ò‚¢çFôÆ÷vW$66R‚“° ¢6öç7B6öæf–rĞ¢fÇVRÓÓÒ&7F—fFVB ¢ò°¢6Ç3¢&7F—fFVB"À¢F—FÆS¢$5D•dDTB"À¢FWF–Ã¢%&VG’f÷"4ò ¢Ğ¢¢fÇVRÓÓĞ¢&v—F–æuö7F—fF–öâ ¢ò°¢6Ç3¢&v—F–ær"À¢F—FÆS¢$5D•dD”är"À¢FWF–Ã ¢$v—F–ærFÖ–â7F—fF–öâ ¢Ğ¢¢fÇVRÓÓĞ¢&W‡—&VB ¢ò°¢6Ç3¢&W‡—&VB"À¢F—FÆS¢$U…•$TB"À¢FWF–Ã ¢$v—F–ærFÖ–â&Wf–Wr ¢Ğ¢¢fÇVRÓÓĞ¢&FV7F—fFVB ¢ò°¢6Ç3¢&FV7F—fFVB"À¢F—FÆS¢$DT5D•dDTB"À¢FWF–Ã¢$6öçF7B7W÷'B ¢Ğ¢¢°¢6Ç3¢&–æ6ö×ÆWFR"À¢F—FÆS¢%4UEUäTTDTB"À¢FWF–Ã ¢$6ö×ÆWFR&öf–ÆR–æf÷&ÖF–öâ ¢Ó° ¢&WGW&â ¢ÆF—`¢6Æ73Ò'&öf–ÆRÖ7F—fF–öâ×7FGW2G¶6öæf–ræ6Ç7Ò ¢à¢Ç7à¢6Æ73Ò'&öf–ÆRÖ7F—fF–öâÖÆ–v‡B ¢&–Ö†–FFVãÒ'G'VR ¢ãÂ÷7ãà ¢ÆF—cà¢Ç7G&öæsà¢G¶6öæf–rçF—FÆWĞ¢Â÷7G&öæsà ¢Ç6ÖÆÃà¢G¶6öæf–ræFWF–ÇĞ¢Â÷6ÖÆÃà¢ÂöF—cà¢ÂöF—cà¢°§Ğ  ¦gVæ7F–öâ&WF–ÆW%&öf–ÆT6&D‡FÖÂ€¢6Æ÷BÀ¢6fVE&öf–ÆRÒçVÆÀ¢’°¢6öç7B&öf–ÆTæÖRĞ¢6fVE&öf–ÆSòç&öf–ÆTæÖRÇÀ¢&öf–ÆRG·6Æ÷GÖ° ¢6öç7BÆö6¶VBĞ¢6Æ÷Bà¢7FFRç&WF–ÆW$ÆÆ÷væ6S° ¢6öç7B&WF–ÆW'2Ğ¢6fVE&öf–ÆSòç&WF–ÆW'2ÇÀ¢·Ó° ¢6öç7B7W7FöÖW%&öf–ÆRĞ¢6fVE&öf–ÆP¢òæ7W7FöÖW%&öf–ÆRÇÀ¢·Ó° ¢6öç7B7W7FöÖW$6&BĞ¢6fVE&öf–ÆP¢òæ7W7FöÖW$6&BÇÀ¢·Ó° ¢6öç7B&VF–æW72Ğ¢6fVE&öf–ÆP¢òç&VF–æW72ÇÀ¢&öf–ÆU&VF–æW72€¢7W7FöÖW%&öf–ÆRÀ¢7W7FöÖW$6&@¢“° ¢6öç7BÖVÖ&W'6†—Ğ¢7FFRæÖVÖ&W'6†—ÇÀ¢·Ó° ¢6öç7B–EW&–öDVæBĞ¢ÖVÖ&W'6†—ç7V'67&—F–öäVæDFFRÇÀ¢ÖVÖ&W'6†—æ7W'&VçEW&–öDVæBÇÀ¢ÖVÖ&W'6†—æ6æ6VÄBÇÀ¢çVÆÃ° ¢6öç7B–D7F—fRĞ¢†47F—fU–DÖVÖ&W'6†—€¢ÖVÖ&W'6†— ¢“° ¢6öç7B6÷VçFF÷vâĞ¢&öf–ÆT6÷VçFF÷vä–æfò‡°¢W‡—&W4C ¢–EW&–öDVæBÀ¢F—5&VÖ–æ–æs ¢ÖVÖ&W'6†—æF—5&VÖ–æ–ærÀ¢7F—fS ¢–D7F—fRÀ¢–æFVf–æ—FS ¢–EW&–öDVæBb`¢–D7F—fP¢Ò“° ¢6öç7B†56fVD6&BĞ¢&ööÆVâ€¢7W7FöÖW$6&@¢òæ6ô6&DçVÖ&W"ÇÀ¢7W7FöÖW$6&@¢òæ6&DçVÖ&W"ÇÀ¢7W7FöÖW$6&@¢òæÖ6¶VDçVÖ&W ¢“° ¢&WGW&â ¢Æ'F–6ÆP¢6Æ73Ò'&WF–ÆW"×&öf–ÆRÖ6&B6ö×7B×&öf–ÆRÖ6&B–B×&öf–ÆRÖ6&BG°¢Æö6¶V@¢ò&Æö6¶VB ¢¢" ¢Ò ¢FF×&WF–ÆW"×&öf–ÆSÒ"G·6Æ÷GÒ ¢à ¢ÆF—`¢6Æ73Ò'&öf–ÆRÖ6ö×7BÖÖ–â ¢à ¢G°¢Æö6¶V@¢ò ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'&öf–ÆRÖ6ö×7B×FövvÆR&öf–ÆRÖ÷VâÖ'WGFöâ ¢F—6&ÆV@¢&–ÖW‡æFVCÒ&fÇ6R ¢à¢Ç7à¢6Æ73Ò'&WF–ÆW"×&öf–ÆRÖçVÖ&W" ¢à¢G·6Æ÷GĞ¢Â÷7ãà ¢Ç7à¢6Æ73Ò'&öf–ÆRÖ6ö×7B×F—FÆR ¢à¢Ç7â6Æ73Ò&W–V'&÷r#à¢”B4ò$ôd”ÄRG·6Æ÷GĞ¢Â÷7ãà ¢Ç7G&öæsà¢G¶W66T‡FÖÂ€¢&öf–ÆTæÖP¢—Ğ¢Â÷7G&öæsà ¢Ç6ÖÆÃà¢&öf–ÆRVæf–Æ&ÆRöâ–÷W"7W'&VçBÆà¢Â÷6ÖÆÃà¢Â÷7ãà¢Âö'WGFöãà ¢Ç7à¢6Æ73Ò'&WF–ÆW"×&öf–ÆRÖÆö6² ¢à¢Äô4´T@¢Â÷7ãà¢ ¢¢ ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'&öf–ÆRÖ6ö×7B×FövvÆR&öf–ÆRÖ÷VâÖ'WGFöâ ¢FF×&öf–ÆR×FövvÆP¢&–ÖW‡æFVCÒ&fÇ6R ¢à¢Ç7à¢6Æ73Ò'&WF–ÆW"×&öf–ÆRÖçVÖ&W" ¢à¢G·6Æ÷GĞ¢Â÷7ãà ¢Ç7à¢6Æ73Ò'&öf–ÆRÖ6ö×7B×F—FÆR ¢à¢Ç7â6Æ73Ò&W–V'&÷r#à¢”B4ò$ôd”ÄRG·6Æ÷GĞ¢Â÷7ãà ¢Ç7G&öæsà¢G¶W66T‡FÖÂ€¢&öf–ÆTæÖP¢—Ğ¢Â÷7G&öæsà ¢Ç6ÖÆÃà¢6Æ–6²ç—v†W&R†W&RFò÷VâæBÖævRF†—2&öf–ÆP¢Â÷6ÖÆÃà¢Â÷7ãà ¢Ç7à¢6Æ73Ò'&öf–ÆRÖ÷VâÖ6öçG&öÂ ¢&–Ö†–FFVãÒ'G'VR ¢à¢Ç7à¢6Æ73Ò'&öf–ÆRÖ÷VâÖ†–çB ¢à¢õTâ$ôd”ÄP¢Â÷7ãà ¢Ç7à¢6Æ73Ò'&öf–ÆRÖ6ö×7BÖ6†Wg&öâ ¢à¢)kà¢Â÷7ãà¢Â÷7ãà¢Âö'WGFöãà ¢ÆF—`¢6Æ73Ò'&öf–ÆR×7FGW2×7F6² ¢à¢G·&VF–æW74&FvT‡FÖÂ€¢&VF–æW70¢—Ğ ¢G·&öf–ÆT7F—fF–öä&FvT‡FÖÂ€¢6fVE&öf–ÆP¢òæ7F—fF–öå7FGW2ÇÀ¢€¢&VF–æW72ç&VG¢ò&v—F–æuö7F—fF–öâ ¢¢&–æ6ö×ÆWFR ¢¢—Ğ ¢G·&öf–ÆT6÷VçFF÷vä&FvT‡FÖÂ€¢6÷VçFF÷và¢—Ğ¢ÂöF—cà¢ ¢Ğ ¢ÂöF—cà ¢G°¢Æö6¶V@¢ò ¢ÆF—`¢6Æ73Ò'&WF–ÆW"×&öf–ÆRÖÆö6¶VBÖÖW76vR ¢à¢Ç7G&öæsà¢F†—2&öf–ÆR—27W'&VçFÇ’Æö6¶VBà¢Â÷7G&öæsà ¢Çà¢–÷W"7W'&VçBÖVÖ&W'6†—ÆÆ÷w0¢G·7FFRç&WF–ÆW$ÆÆ÷væ6WĞ¢G°¢7FFRç&WF–ÆW$ÆÆ÷væ6RÓÓÒ¢ò'&öf–ÆR ¢¢'&öf–ÆW2 ¢Òà¢Â÷à¢ÂöF—cà¢ ¢¢ ¢ÆF—`¢6Æ73Ò'&öf–ÆR×V–6²ÖWFöf–ÆÂ ¢à¢ÆÆ&VÃà¢Ç7ãà¢WFòf–ÆÂ6†—–ærv—F€¢Â÷7ãà ¢Ç6VÆV7@¢FF×W'6öæÂ×6†—–ær×6VÆV7@¢à¢G·&öf–ÆU6fVDFG&W74÷F–öç2€¢6fVE&öf–ÆP¢òç6VÆV7FVDFG&W74–BÇÀ¢" ¢—Ğ¢Â÷6VÆV7Cà¢ÂöÆ&VÃà ¢ÆÆ&VÃà¢Ç7ãà¢WFòf–ÆÂ6&Bv—F€¢Â÷7ãà ¢Ç6VÆV7@¢FF×W'6öæÂÖ6&B×6VÆV7@¢à¢G·&öf–ÆU6fVE–ÖVçD÷F–öç2€¢6fVE&öf–ÆP¢òç6VÆV7FVE–ÖVçD–BÇÀ¢" ¢—Ğ¢Â÷6VÆV7Cà¢ÂöÆ&VÃà ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'6V6öæF'’&öf–ÆRÖWFöf–ÆÂÖÇ’ ¢FF×W'6öæÂÖWFöf–ÆÂÖf–ÆÃÒ"G·6Æ÷GÒ ¢à¢f–ÆÂ&öf–ÆP¢Âö'WGFöãà¢ÂöF—cà ¢ÆF—`¢6Æ73Ò'&öf–ÆRÖ6öÆÆ6–&ÆRÖ&öG’ ¢FF×&öf–ÆRÖ&öG¢†–FFVà¢à¢Æf÷&Ğ¢6Æ73Ò'&WF–ÆW"×&öf–ÆRÖf÷&Ò–B×&öf–ÆRÖgVÆÂÖf÷&Ò ¢FF×&WF–ÆW"×&öf–ÆRÖf÷&ÓÒ"G·6Æ÷GÒ ¢à ¢Æ–çW@¢G—SÒ&†–FFVâ ¢æÖSÒ'6†—–ætFG&W74–B ¢fÇVSÒ"G¶W66T‡FÖÂ€¢6fVE&öf–ÆP¢òç6VÆV7FVDFG&W74–BÇÀ¢" ¢—Ò ¢à ¢Æ–çW@¢G—SÒ&†–FFVâ ¢æÖSÒ'–ÖVçDÖWF†öD–B ¢fÇVSÒ"G¶W66T‡FÖÂ€¢6fVE&öf–ÆP¢òç6VÆV7FVE–ÖVçD–BÇÀ¢" ¢—Ò ¢à ¢Ç6V7F–öà¢6Æ73Ò'–B×&öf–ÆR×6V7F–öâ ¢à¢Ç7â6Æ73Ò&W–V'&÷r#à¢$ôd”ÄRDUD”Å0¢Â÷7ãà ¢ÆÆ&VÃà¢&öf–ÆRæÖP¢Æ–çW@¢G—SÒ'FW‡B ¢æÖSÒ'&öf–ÆTæÖR ¢fÇVSÒ"G¶W66T‡FÖÂ€¢&öf–ÆTæÖP¢—Ò ¢Ö†ÆVæwFƒÒ#ƒ ¢Æ6V†öÆFW#Ò$W†×ÆS¢W'6öæÂ ¢&WV—&V@¢à¢ÂöÆ&VÃà¢Â÷6V7F–öãà ¢ÆFWF–Ç0¢6Æ73Ò'–B×&öf–ÆR×6V7F–öâ–B×&öf–ÆR×7V'6V7F–öâ ¢÷Vãà¢Ç7VÖÖ'¢6Æ73Ò'–B×&öf–ÆR×7V'6V7F–öâ×7VÖÖ'’ ¢à¢ÆF—cà¢Ç7â6Æ73Ò&W–V'&÷r#à¢4„•”är”ädõ$ÔD”ôà¢Â÷7ãà ¢Ç7G&öæsà¢6†—–ær–æf÷&ÖF–öà¢Â÷7G&öæsà¢ÂöF—cà ¢Ç7à¢6Æ73Ò'–B×&öf–ÆR×7V'6V7F–öâÖ7F–öâ ¢FF×6V7F–öâÖ7F–öà¢à¢4Ä”4²DòõTà¢Â÷7ãà ¢Ç7à¢6Æ73Ò'&öf–ÆRÖÖ–æ’×7FGW2G°¢&VF–æW72ç6†—–æu&VG¢ò'&VG’ ¢¢&Ö—76–ær ¢Ò ¢à¢G°¢&VF–æW72ç6†—–æu&VG¢ò.)xò$TE’ ¢¢.)xòÔ•54”är ¢Ğ¢Â÷7ãà ¢Ç7à¢6Æ73Ò'–B×&öf–ÆR×7V'6V7F–öâÖ6†Wg&öâ ¢&–Ö†–FFVãÒ'G'VR ¢à¢)kà¢Â÷7ãà¢Â÷7VÖÖ'“à ¢ÆF—`¢6Æ73Ò'–B×&öf–ÆR×7V'6V7F–öâÖ&öG’ ¢à¢ÆF—b6Æ73Ò'Gvò#à¢ÆÆ&VÃà¢f—'7BæÖP¢Æ–çW@¢æÖSÒ&f—'7DæÖR ¢fÇVSÒ"G¶W66T‡FÖÂ€¢7W7FöÖW%&öf–ÆP¢æf—'7DæÖRÇÀ¢" ¢—Ò ¢&WV—&V@¢à¢ÂöÆ&VÃà ¢ÆÆ&VÃà¢Æ7BæÖP¢Æ–çW@¢æÖSÒ&Æ7DæÖR ¢fÇVSÒ"G¶W66T‡FÖÂ€¢7W7FöÖW%&öf–ÆP¢æÆ7DæÖRÇÀ¢" ¢—Ò ¢&WV—&V@¢à¢ÂöÆ&VÃà¢ÂöF—cà ¢ÆF—b6Æ73Ò'Gvò#à¢ÆÆ&VÃà¢VÖ–À¢Æ–çW@¢G—SÒ&VÖ–Â ¢æÖSÒ&VÖ–Â ¢fÇVSÒ"G¶W66T‡FÖÂ€¢7W7FöÖW%&öf–ÆP¢æVÖ–ÂÇÀ¢7FFRæ7W7FöÖW ¢òæVÖ–ÂÇÀ¢" ¢—Ò ¢&WV—&V@¢à¢ÂöÆ&VÃà ¢ÆÆ&VÃà¢†öæP¢Æ–çW@¢æÖSÒ'†öæR ¢fÇVSÒ"G¶W66T‡FÖÂ€¢7W7FöÖW%&öf–ÆP¢ç†öæRÇÀ¢" ¢—Ò ¢à¢ÂöÆ&VÃà¢ÂöF—cà ¢ÆÆ&VÃà¢FG&W70¢Æ–çW@¢æÖSÒ&FG&W72 ¢fÇVSÒ"G¶W66T‡FÖÂ€¢7W7FöÖW%&öf–ÆP¢æFG&W72ÇÀ¢" ¢—Ò ¢&WV—&V@¢à¢ÂöÆ&VÃà ¢ÆÆ&VÃà¢FG&W72 ¢Æ–çW@¢æÖSÒ&FG&W73" ¢fÇVSÒ"G¶W66T‡FÖÂ€¢7W7FöÖW%&öf–ÆP¢æFG&W73"ÇÀ¢" ¢—Ò ¢m«ëŒ+Š×®º+º$zzb¥à                 >
                    </label>

                    <div class="two">
                      <label>
                        City
                        <input
                          name="city"
                          value="${escapeHtml(
                            customerProfile
                              .city ||
                            ""
                          )}"
                          required
                        >
                      </label>

                      <label>
                        State
                        <input
                          name="state"
                          value="${escapeHtml(
                            customerProfile
                              .state ||
                            ""
                          )}"
                          required
                        >
                      </label>
                    </div>

                    <div class="two">
                      <label>
                        ZIP
                        <input
                          name="zip"
                          value="${escapeHtml(
                            customerProfile
                              .zip ||
                            ""
                          )}"
                          required
                        >
                      </label>

                      <label>
                        Country
                        <input
                          name="country"
                          value="${escapeHtml(
                            customerProfile
                              .country ||
                            "US"
                          )}"
                          required
                        >
                      </label>
                    </div>
                    </div>
                  </details>

                  <details
                    class="paid-profile-section paid-profile-subsection"
                   open>
                    <summary
                      class="paid-profile-subsection-summary"
                    >
                      <div>
                        <span class="eyebrow">
                          CARD INFORMATION
                        </span>

                        <strong>
                          Card Information
                        </strong>
                      </div>

                      <span
                        class="paid-profile-subsection-action"
                        data-section-action
                      >
                        CLICK TO OPEN
                      </span>

                      <span
                        class="profile-mini-status ${
                          readiness.cardReady
                            ? "ready"
                            : "missing"
                        }"
                      >
                        ${
                          readiness.cardReady
                            ? "â— READY"
                            : "â— MISSING"
                        }
                      </span>

                      <span
                        class="paid-profile-subsection-chevron"
                        aria-hidden="true"
                      >
                        â–¾
                      </span>
                    </summary>

                    <div
                      class="paid-profile-subsection-body"
                    >
                    <div class="two">
                      <label>
                        Card Label
                        <input
                          name="cardLabel"
                          value="${escapeHtml(
                            customerCard
                              .cardLabel ||
                            ""
                          )}"
                          placeholder="Example: Personal Visa"
                        >
                      </label>

                      <label>
                        Cardholder Name
                        <input
                          name="cardholder"
                          value="${escapeHtml(
                            customerCard
                              .cardholder ||
                            ""
                          )}"
                          required
                        >
                      </label>
                    </div>

                    <label>
                      Card Number
                      <input
                        type="text"
                        name="acoCardNumber"
                        inputmode="numeric"
                        autocomplete="off"
                        value="${escapeHtml(
                          customerCard.acoCardNumber ||
                          customerCard.cardNumber ||
                          ""
                        )}"
                        ${
                          hasSavedCard
                            ? ""
                            : "required"
                        }
                        placeholder="Enter card number"
                      >
                    </label>

                    <div class="two">
                      <label>
                        Expiration Month
                        <input
                          name="expMonth"
                          inputmode="numeric"
                          maxlength="2"
                          value="${escapeHtml(
                            customerCard
                              .expMonth ||
                            ""
                          )}"
                          placeholder="MM"
                          required
                        >
                      </label>

                      <label>
                        Expiration Year
                        <input
                          name="expYear"
                          inputmode="numeric"
                          maxlength="4"
                          value="${escapeHtml(
                            customerCard
                              .expYear ||
                            ""
                          )}"
                          placeholder="YYYY"
                          required
                        >
                      </label>
                    </div>

                    <label>
                      Security Code
                      <input
                        type="text"
                        name="securityCode"
                        autocomplete="off"
                        value="${escapeHtml(
                          customerCard.securityCode ||
                          ""
                        )}"
                        placeholder="Security Code"
                      >
                    </label>

                    </div>
                  </details>

                  <details
                    class="paid-profile-section paid-profile-subsection"
                  >
                    <summary
                      class="paid-profile-subsection-summary"
                    >
                      <div>
                        <span class="eyebrow">
                          RETAILER INFORMATION
                        </span>

                        <strong>
                          Retailer Information
                        </strong>
                      </div>

                      <span
                        class="paid-profile-subsection-action"
                        data-section-action
                      >
                        CLICK TO OPEN
                      </span>

                      <span
                        class="paid-profile-subsection-chevron"
                        aria-hidden="true"
                      >
                        â–¾
                      </span>
                    </summary>

                    <div
                      class="paid-profile-subsection-body"
                    >
                    <div
                      class="retailer-credentials-grid"
                    >
                      ${RETAILERS
                        .map(
                          retailer =>
                            retailerFieldsHtml(
                              retailer,
                              retailers[
                                retailer.key
                              ] || {}
                            )
                        )
                        .join("")}
                    </div>
                    </div>
                  </details>

                  <div
                    class="retailer-profile-save-row"
                  >
                    <div
                      class="account-message retailer-profile-save-message"
                      data-retailer-profile-message="${slot}"
                      hidden
                    ></div>

                    <button
                      type="submit"
                      class="primary retailer-profile-save"
                    >
                      Save Profile ${slot}
                    </button>
                  </div>
                </form>
              </div>
            `
      }
    </article>
  `;
}

function specialProfileCardHtml(
  profile
) {
  if (!profile) {
    return "";
  }

  const profileType =
    profile.profileType ===
    "rented"
      ? "rented"
      : "free";

  const profileName =
    profileType === "rented"
      ? "RENTED PROFILE"
      : "FREE PROFILE";

  const retailers =
    profile.retailers || {};

  const daysRemaining =
    profile.daysRemaining;

  const indefinite =
    profile.durationType ===
    "indefinite";

  const statusClass =
    indefinite ||
    (
      Number.isFinite(
        Number(daysRemaining)
      ) &&
      Number(daysRemaining) > 7
    )
      ? "status-green"
      : "status-yellow";

  const timeRemaining =
    indefinite
      ? "INDEFINITE"
      : `${Math.max(
          0,
          Number(daysRemaining) || 0
        )} ${
          Number(daysRemaining) === 1
            ? "DAY"
            : "DAYS"
        }`;

  const expirationText =
    indefinite
      ? "NO EXPIRATION"
      : formatDate(
          profile.expiresAt
        );

  return `
    <article
      class="retailer-profile-card special-retailer-profile"
      data-special-profile="${escapeHtml(
        profileType
      )}"
    >

      <div
        class="retailer-profile-card-head"
      >

        <div
          class="retailer-profile-title"
        >

          <span
            class="retailer-profile-number"
          >
            ${
              profileType === "free"
                ? "F"
                : "R"
            }
          </span>

          <div>

            <span class="eyebrow">
              SPECIAL ACO ACCESS
            </span>

            <h3>
              ${profileName}
            </h3>

          </div>

        </div>

        <span
          class="retailer-profile-active ${statusClass}"
        >
          â— ACTIVE
        </span>

      </div>

      <div
        class="retailer-profile-name-field"
      >

        <p>
          <strong>
            ACCESS:
          </strong>
          ${escapeHtml(
            profile.durationLabel ||
            "INDEFINITELY"
          )}
        </p>

        <p>
          <strong>
            TIME REMAINING:
          </strong>
          ${escapeHtml(
            timeRemaining
          )}
        </p>

        <p>
          <strong>
            EXPIRATION:
          </strong>
          ${escapeHtml(
            expirationText
          )}
        </p>

      </div>

    <form
  class="special-profile-form"
  data-special-profile-form="${escapeHtml(
    profileType
  )}"
>

  <div
    class="retailer-credentials-grid"
  >
 &Ú±î¸Â¸­yêë¢°k¢G§¦*^Gµ$UD”ÄU%0¢æÖ€¢&WF–ÆW"Óà¢&WF–ÆW$f–VÆG4‡FÖÂ€¢&WF–ÆW"À¢&WF–ÆW'5°¢&WF–ÆW"æ¶W¢ÒÇÂ·Ğ¢¢¢æ¦ö–â‚""—Ğ¢ÂöF—cà ¢ÆF—`¢6Æ73Ò'&WF–ÆW"×&öf–ÆR×6fR×&÷r ¢à ¢ÆF—`¢6Æ73Ò&66÷VçBÖÖW76vR&WF–ÆW"×&öf–ÆR×6fRÖÖW76vR ¢FF×7V6–Â×&öf–ÆRÖÖW76vSÒ"G¶W66T‡FÖÂ€¢&öf–ÆUG—P¢—Ò ¢†–FFVà¢ãÂöF—cà ¢Æ'WGFöà¢G—SÒ'7V&Ö—B ¢6Æ73Ò'&–Ö'’&WF–ÆW"×&öf–ÆR×6fR ¢à¢6fRG·&öf–ÆTæÖWĞ¢Âö'WGFöãà ¢ÂöF—cà £Âöf÷&Óà ¢Âö'F–6ÆSà¢°§Ğ  ¦gVæ7F–öâÖævVDFG&W74÷F–öç4‡FÖÂ€¢ÖVÖ&W'6†— ¢’°¢6öç7B7W'&VçBĞ¢ÖVÖ&W'6†—òæ7W7FöÖW%&öf–ÆRb`¢G—VöbÖVÖ&W'6†—æ7W7FöÖW%&öf–ÆRÓÓĞ¢&ö&¦V7B ¢òÖVÖ&W'6†—æ7W7FöÖW%&öf–ÆP¢¢·Ó° ¢6öç7B6VVâĞ¢æWr6WB‚“° ¢6öç7B÷F–öç2Ò°¢ ¢Æ÷F–öâfÇVSÒ&7W'&VçB#à¢7W'&VçBòÖçVÂFG&W70¢Âö÷F–öãà¢ ¢Ó° ¢f÷"†6öç7B÷&FW"öb7FFRæ÷&FW'2’°¢6öç7B&öf–ÆRĞ¢vWD÷&FW%&öf–ÆR€¢÷&FW ¢“° ¢6öç7B¶W’Ğ¢°¢&öf–ÆRæFG&W72À¢&öf–ÆRæFG&W73"À¢&öf–ÆRæ6—G’À¢&öf–ÆRç7FFRÀ¢&öf–ÆRç¦—À¢&öf–ÆRæ6÷VçG'¢Ğ¢æf–ÇFW"„&ööÆVâ¢æ¦ö–â‚'Â"¢çFôÆ÷vW$66R‚“° ¢–b‚¶W’ÇÂ6VVâæ†2†¶W’’’°¢6öçF–çVS°¢Ğ ¢6VVâæFB†¶W’“° ¢6öç7BÆ&VÂĞ¢°¢&öf–ÆRæFG&W72À¢&öf–ÆRæFG&W73"À¢&öf–ÆRæ6—G’À¢&öf–ÆRç7FFRÀ¢&öf–ÆRç¦— ¢Ğ¢æf–ÇFW"„&ööÆVâ¢æ¦ö–â‚"Â"“° ¢÷F–öç2çW6‚† ¢Æ÷F–öà¢fÇVSÒ"G¶W66T‡FÖÂ€¢vWD÷&FW$çVÖ&W"†÷&FW"¢—Ò ¢à¢G¶W66T‡FÖÂ€¢Æ&VÂÇÀ¢%6fVB÷&FW"FG&W72 ¢—Ğ¢Âö÷F–öãà¢“°¢Ğ ¢&WGW&â÷F–öç2æ¦ö–â‚""“°§Ğ  ¦gVæ7F–öâÖævVDÖVÖ&W'6†—6&D‡FÖÂ€¢ÖVÖ&W'6†— ¢’°¢–b‚ÖVÖ&W'6†—’°¢&WGW&â"#°¢Ğ ¢6öç7BG—RĞ¢ÖVÖ&W'6†—ç&öf–ÆUG—RÓÓĞ¢'&VçFVB ¢ò'&VçFVB ¢¢&g&VR#° ¢6öç7BF—FÆRĞ¢G—RÓÓÒ'&VçFVB ¢ò%$TåDTB$ôd”ÄR ¢¢$t”eDTB$ôd”ÄR#° ¢6öç7BÆWGFW"Ğ¢G—RÓÓÒ'&VçFVB ¢ò%" ¢¢$b#° ¢6öç7B&öf–ÆRĞ¢ÖVÖ&W'6†—æ7W7FöÖW%&öf–ÆRb`¢G—VöbÖVÖ&W'6†—æ7W7FöÖW%&öf–ÆRÓÓĞ¢&ö&¦V7B ¢òÖVÖ&W'6†—æ7W7FöÖW%&öf–ÆP¢¢çVÆÃ° ¢6öç7B6&BĞ¢ÖVÖ&W'6†—æ7W7FöÖW$6&Bb`¢G—VöbÖVÖ&W'6†—æ7W7FöÖW$6&BÓÓĞ¢&ö&¦V7B ¢òÖVÖ&W'6†—æ7W7FöÖW$6&@¢¢çVÆÃ° ¢6öç7B&VF–æW72Ğ¢&öf–ÆU&VF–æW72€¢&öf–ÆRÀ¢6&@¢“° ¢6öç7Bv—F–æt7F—fF–öâĞ¢7G&–ær€¢ÖVÖ&W'6†—æ7F—fF–öå7FGW2ÇÀ¢" ¢’ÓÓĞ¢&v—F–æuö7F—fF–öâ#° ¢6öç7B–æFVf–æ—FRĞ¢ÖVÖ&W'6†—æGW&F–öåG—RÓÓĞ¢&–æFVf–æ—FR#° ¢6öç7BF—5&VÖ–æ–ærĞ¢–æFVf–æ—FP¢òçVÆÀ¢¢ÖF‚æÖ‚€¢À¢çVÖ&W"€¢ÖVÖ&W'6†—æF—5&VÖ–æ–æp¢’ÇÂ ¢“° ¢6öç7B6÷VçFF÷vâĞ¢v—F–æt7F—fF–öà¢ò°¢6Æ74æÖS ¢'v&æ–ær"À¢Æ&VÃ ¢$5D•dD”är"À¢FWF–Ã ¢%F–ÖW"7F'G2gFW"7F—fF–öâ ¢Ğ¢¢&öf–ÆT6÷VçFF÷vä–æfò‡°¢W‡—&W4C ¢ÖVÖ&W'6†—æW‡—&W4BÀ¢F—5&VÖ–æ–ærÀ¢7F—fS ¢ÖVÖ&W'6†—æ7F—fRÓĞ¢fÇ6RÀ¢–æFVf–æ—FP¢Ò“° ¢&WGW&â ¢Æ'F–6ÆP¢6Æ73Ò'&WF–ÆW"×&öf–ÆRÖ6&B7V6–Â×&WF–ÆW"×&öf–ÆRÖævVB×7FF–2×&öf–ÆR ¢FFÖÖævVBÖÖVÖ&W'6†—Ò"G¶W66T‡FÖÂ‡G—R—Ò ¢FFÖÖævVBÖ76–væÖVçCÒ"G¶W66T‡FÖÂ€¢ÖVÖ&W'6†—æ76–væÖVçD–BÇÂ" ¢—Ò ¢à¢ÆF—`¢6Æ73Ò'&öf–ÆRÖ6ö×7BÖÖ–â ¢à¢ÆF—`¢6Æ73Ò&ÖævVB×7FF–2×F—FÆR ¢à¢Ç7à¢6Æ73Ò'&WF–ÆW"×&öf–ÆRÖçVÖ&W" ¢à¢G¶ÆWGFW'Ğ¢Â÷7ãà ¢Ç7à¢6Æ73Ò'&öf–ÆRÖ6ö×7B×F—FÆR ¢à¢Ç7â6Æ73Ò&W–V'&÷r#à¢ÔätTB4ò44U50¢Â÷7ãà ¢Ç7G&öæsà¢G·F—FÆWĞ¢Â÷7G&öæsà ¢Ç6ÖÆÃà¢G°¢v—F–æt7F—fF–öà¢ò%D”ÔU"5D%E2t„Tâ5D•dDTB ¢¢€¢–æFVf–æ—FP¢ò$äòU…•$D”ôâ ¢¢G¶F—5&VÖ–æ–æwÒG°¢F—5&VÖ–æ–ærÓÓÒ¢ò$D’ ¢¢$D•2 ¢ÒÄTeF ¢¢Ğ¢Â÷6ÖÆÃà¢Â÷7ãà¢ÂöF—cà ¢ÆF—`¢6Æ73Ò'&öf–ÆR×7FGW2×7F6²ÖævVB×7FGW2×7F6² ¢à¢G·&VF–æW74&FvT‡FÖÂ€¢&VF–æW70¢—Ğ ¢G·&öf–ÆT7F—fF–öä&FvT‡FÖÂ€¢ÖVÖ&W'6†—æ7F—fF–öå7FGW2ÇÀ¢€¢&VF–æW72ç&VG¢ò&v—F–æuö7F—fF–öâ ¢¢&–æ6ö×ÆWFR ¢¢—Ğ ¢G·&öf–ÆT6÷VçFF÷vä&FvT‡FÖÂ€¢6÷VçFF÷và¢—Ğ¢ÂöF—cà¢ÂöF—cà ¢ÆF—`¢6Æ73Ò'&öf–ÆR×V–6²ÖWFöf–ÆÂ ¢à¢ÆÆ&VÃà¢Ç7ãà¢WFòf–ÆÂ6†—–ærv—F€¢Â÷7ãà ¢Ç6VÆV7@¢FFÖÖævVB×6†—–ær×6VÆV7@¢à¢G·&öf–ÆU6fVDFG&W74÷F–öç2€¢ÖVÖ&W'6†—ç6VÆV7FVDFG&W74–BÇÂ" ¢—Ğ¢Â÷6VÆV7Cà¢ÂöÆ&VÃà ¢ÆÆ&VÃà¢Ç7ãà¢WFòf–ÆÂ6&Bv—F€¢Â÷7ãà ¢Ç6VÆV7@¢FFÖÖævVBÖ6&B×6VÆV7@¢à¢G·&öf–ÆU6fVE–ÖVçD÷F–öç2€¢ÖVÖ&W'6†—ç6VÆV7FVE–ÖVçD–BÇÂ" ¢—Ğ¢Â÷6VÆV7Cà¢ÂöÆ&VÃà ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'6V6öæF'’&öf–ÆRÖWFöf–ÆÂÖÇ’ ¢FFÖÖævVBÖWFöf–ÆÂÖÇ¢à¢Ç’f×²6fP¢Âö'WGFöãà¢ÂöF—cà¢Âö'F–6ÆSà¢°§Ğ  ¦gVæ7F–öâ&–æE&öf–ÆTw&÷WG&÷F÷vç2‚’°¢Fö7VÖVç@¢çVW'•6VÆV7F÷$ÆÂ€¢"ç&öf–ÆRÖw&÷WÖG&÷F÷vâ ¢¢æf÷$V6‚†w&÷WÓâ°¢–b€¢w&÷WæFF6W@¢æw&÷W&÷VæBÓÓĞ¢'G'VR ¢’°¢&WGW&ã°¢Ğ ¢w&÷WæFF6WBæw&÷W&÷VæBĞ¢'G'VR#° ¢6öç7BÆ&VÂĞ¢w&÷WçVW'•6VÆV7F÷"€¢%¶FF×&öf–ÆRÖw&÷WÖÆ&VÅÒ ¢“° ¢6öç7B7–æ2Ò‚’Óâ°¢–b‚Æ&VÂ’&WGW&ã° ¢Æ&VÂçFW‡D6öçFVçBĞ¢w&÷Wæ÷Và¢ò€¢Æ&VÂæFF6W@¢æ†–FUFW‡BÇÀ¢$„”DRÄÂ ¢¢¢€¢Æ&VÂæFF6W@¢ç6†÷uFW‡BÇÀ¢%4„õrÄÂ ¢“°¢Ó° ¢w&÷WæFDWfVçDÆ—7FVæW"€¢'FövvÆR"À¢7–æ0¢“° ¢7–æ2‚“°¢Ò“°§Ğ   ¦gVæ7F–öâ&–æE–E&öf–ÆU7V'6V7F–öç2€¢&ö÷BÒFö7VÖVç@¢’°¢&ö÷@¢çVW'•6VÆV7F÷$ÆÂ€¢"ç–B×&öf–ÆR×7V'6V7F–öâ ¢¢æf÷$V6‚‡6V7F–öâÓâ°¢–b€¢6V7F–öâæFF6W@¢ç7V'6V7F–öä&÷VæBÓÓĞ¢'G'VR ¢’°¢&WGW&ã°¢Ğ ¢6V7F–öâæFF6W@¢ç7V'6V7F–öä&÷VæBĞ¢'G'VR#° ¢6öç7B7F–öâĞ¢6V7F–öâçVW'•6VÆV7F÷"€¢%¶FF×6V7F–öâÖ7F–öåÒ ¢“° ¢6öç7B7–æ2Ò‚’Óâ°¢–b†7F–öâ’°¢7F–öâçFW‡D6öçFVçBĞ¢6V7F–öâæ÷Và¢ò$4Ä”4²Dò4Äõ4R ¢¢$4Ä”4²DòõTâ#°¢Ğ¢Ó° ¢6V7F–öâæFDWfVçDÆ—7FVæW"€¢'FövvÆR"À¢7–æ0¢“° ¢7–æ2‚“°¢Ò“°§Ğ  ¦gVæ7F–öâ&V÷Vå–E&öf–ÆR€¢6Æ÷@¢’°¢6öç7B6&BĞ¢Fö7VÖVçBçVW'•6VÆV7F÷"€¢¶FF×&WF–ÆW"×&öf–ÆSÒ"G·6Æ÷GÒ%Ö ¢“° ¢6öç7B&öG’Ğ¢6&CòçVW'•6VÆV7F÷"€¢%¶FF×&öf–ÆRÖ&öG•Ò ¢“° ¢6öç7B'WGFöâĞ¢6&CòçVW'•6VÆV7F÷"€¢%¶FF×&öf–ÆR×FövvÆUÒ ¢“° ¢–b€¢6&BÇÀ¢&öG’ÇÀ¢'WGFöà¢’°¢&WGW&ã°¢Ğ ¢&öG’æ†–FFVâĞ¢fÇ6S° ¢6&Bæ6Æ74Æ—7BæFB€¢&W‡æFVB ¢“° ¢'WGFöâç6WDGG&–'WFR€¢&&–ÖW‡æFVB"À¢'G'VR ¢“° ¢&–æE–E&öf–ÆU7V'6V7F–öç2€¢6&@¢“°§Ğ  ¦gVæ7F–öâ&–æE&öf–ÆT66÷&F–öç2‚’°¢Fö7VÖVç@¢çVW'•6VÆV7F÷$ÆÂ€¢"æ6ö×7B×&öf–ÆRÖ6&B¶FF×&öf–ÆR×FövvÆUÒ ¢¢æf÷$V6‚†'WGFöâÓâ°¢–b€¢'WGFöâæFF6WBæ&÷VæBÓÓĞ¢'G'VR ¢’°¢&WGW&ã°¢Ğ ¢'WGFöâæFF6WBæ&÷VæBĞ¢'G'VR#° ¢'WGFöâæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6öç7B6&BĞ¢'WGFöâæ6Æ÷6W7B€¢"æ6ö×7B×&öf–ÆRÖ6&B ¢“° ¢6öç7B&öG’Ğ¢6&CòçVW'•6VÆV7F÷"€¢%¶FF×&öf–ÆRÖ&öG•Ò ¢“° ¢–b‚&öG’’°¢&WGW&ã°¢Ğ ¢6öç7B÷Væ–ærĞ¢&öG’æ†–FFVã° ¢&öG’æ†–FFVâĞ¢÷Væ–æs° ¢6&Còæ6Æ74Æ—7BçFövvÆR€¢&W‡æFVB"À¢÷Væ–æp¢“° ¢'WGFöâç6WDGG&–'WFR€¢&&–ÖW‡æFVB"À¢÷Væ–æp¢ò'G'VR ¢¢&fÇ6R ¢“°¢Ğ¢“°¢Ò“°§Ğ   ¦gVæ7F–öâÖævVE&öf–ÆW4w&÷W—4÷Vâ‚’°¢6öç7Bw&÷WĞ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'&WF–ÆW"×&öf–ÆW2 ¢¢òçVW'•6VÆV7F÷"€¢"ç&öf–ÆRÖw&÷WÖG&÷F÷vâç7V6–Â×&öf–ÆRÖ6FVv÷'’ ¢“° ¢&WGW&â&ööÆVâ€¢w&÷Wòæ÷Và¢“°§Ğ  ¦gVæ7F–öâ&W7F÷&TÖævVE&öf–ÆW4w&÷W÷Vâ€¢6†÷VÆD÷Và¢’°¢–b‚6†÷VÆD÷Vâ’°¢&WGW&ã°¢Ğ ¢6öç7Bw&÷WĞ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'&WF–ÆW"×&öf–ÆW2 ¢¢òçVW'•6VÆV7F÷"€¢"ç&öf–ÆRÖw&÷WÖG&÷F÷vâç7V6–Â×&öf–ÆRÖ6FVv÷'’ ¢“° ¢–b‚w&÷W’°¢&WGW&ã°¢Ğ ¢w&÷Wæ÷VâĞ¢G'VS° ¢6öç7BÆ&VÂĞ¢w&÷WçVW'•6VÆV7F÷"€¢%¶FF×&öf–ÆRÖw&÷WÖÆ&VÅÒ ¢“° ¢–b†Æ&VÂ’°¢Æ&VÂçFW‡D6öçFVçBĞ¢Æ&VÂæFF6W@¢æ†–FUFW‡BÇÀ¢$„”DRÄÂt”eDTBb$TåDTB$ôd”ÄU2#°¢Ğ§Ğ  ¦7–æ2gVæ7F–öâÇ”ÖævVE6fVD–æfò€¢6&@¢’°¢6öç7B76–væÖVçD–BĞ¢6&CòæFF6W@¢æÖævVD76–væÖVçC° ¢6öç7BG—RĞ¢6&CòæFF6W@¢æÖævVDÖVÖ&W'6†—° ¢6öç7B6†—–ætFG&W74–BĞ¢6&CòçVW'•6VÆV7F÷"€¢%¶FFÖÖævVB×6†—–ær×6VÆV7EÒ ¢“òçfÇVRÇÂ"#° ¢6öç7B–ÖVçDÖWF†öD–BĞ¢6&CòçVW'•6VÆV7F÷"€¢%¶FFÖÖævVBÖ6&B×6VÆV7EÒ ¢“òçfÇVRÇÂ"#° ¢–b€¢6†—–ætFG&W74–Bb`¢–ÖVçDÖWF†öD–@¢’°¢6†÷t66÷VçDÖW76vR€¢$6†ö÷6R6fVB6†—–ærFG&W72÷"6&Bf—'7Bâ"À¢&W'&÷" ¢“°¢&WGW&ã°¢Ğ ¢–b€¢DÔ”åõ$Ud”UuôÔôDP¢’°¢6öç7B&VçFÇ2Ğ¢FÖ–åFW7E&VE&VçFÇ2‚“° ¢6öç7B—FVÒĞ¢&VçFÇ2æf–æB€¢&VçFÂÓà¢7G&–ær€¢&VçFÂæ76–væÖVçD–@¢’ÓÓĞ¢7G&–ær€¢76–væÖVçD–@¢¢“° ¢–b‚—FVÒ’°¢6†÷t66÷VçDÖW76vR€¢%F†—2FW7B&VçFÂ6÷VÆBæ÷B&Rf÷VæBâ"À¢&W'&÷" ¢“°¢&WGW&ã°¢Ğ ¢6öç7BFG&W72Ğ¢6fVDFG&W74'”–B€¢6†—–ætFG&W74–@¢“° ¢6öç7B–ÖVçBĞ¢6fVE–ÖVçD'”–B€¢–ÖVçDÖWF†öD–@¢“° ¢–b†FG&W72’°¢—FVÒæ7W7FöÖW%&öf–ÆRÒ°¢âââ†—FVÒæ7W7FöÖW%&öf–ÆRÇÂ·Ò’À¢f—'7DæÖS ¢FG&W72æf—'7DæÖRÇÂ""À¢Æ7DæÖS ¢FG&W72æÆ7DæÖRÇÂ""À¢FG&W73 ¢FG&W72æFG&W72ÇÂ""À¢FG&W73# ¢FG&W72æFG&W73"ÇÂ""À¢6—G“ ¢FG&W72æ6—G’ÇÂ""À¢7FFS ¢FG&W72ç7FFRÇÂ""À¢¦— ¢FG&W72ç¦—ÇÂ""À¢6÷VçG'“ ¢FG&W72æ6÷VçG'’ÇÂ" ¢Ó° ¢—FVÒç6VÆV7FVDFG&W74–BĞ¢6†—–ætFG&W74–C°¢Ğ ¢–b‡–ÖVçB’°¢—FVÒæ7W7FöÖW$6&BÒ°¢6&DÆ&VÃ ¢–ÖVçBæ6&DÆ&VÂÇÂ""À¢6&F†öÆFW# ¢–ÖVçBæ6&F†öÆFW"ÇÂ""À¢6ô6&DçVÖ&W# ¢–ÖVçBçFW7D6&DçVÖ&W"ÇÀ¢#C"À¢W‡ÖöçFƒ ¢–ÖVçBæW‡ÖöçF‚ÇÂ#""À¢W‡–V# ¢–ÖVçBæW‡–V"ÇÂ##3"À¢6V7W&—G”6öFS ¢%DU5B ¢Ó° ¢—FVÒç6VÆV7FVE–ÖVçD–BĞ¢–ÖVçDÖWF†öD–C°¢Ğ ¢6öç7B&VF–æW72Ğ¢&öf–ÆU&VF–æW72€¢—FVÒæ7W7FöÖW%&öf–ÆRÀ¢—FVÒæ7W7FöÖW$6&@¢“° ¢–b€¢&VF–æW72ç&VG’b`¢—FVÒæ7F—fF–öå7FGW2ÓĞ¢&7F—fFVB ¢’°¢—FVÒæ7F—fF–öå7FGW2Ğ¢&v—F–æuö7F—fF–öâ#°¢ÒVÇ6R–b€¢&VF–æW72ç&VG¢’°¢—FVÒæ7F—fF–öå7FGW2Ğ¢&–æ6ö×ÆWFR#°¢Ğ ¢G'’°¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’öFÖ–â÷FW7BÖÖævVB×&öf–ÆR×v÷&¶fÆ÷r"À¢°¢ÖWF†öC¢%UB"À¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ¢&öG“ ¢¥4ôâç7G&–æv–g’‡°¢G—S ¢'&VçFVB"À¢76–væÖVçD–C ¢—FVÒæ76–væÖVçD–BÀ¢7W7FöÖW%&öf–ÆS ¢—FVÒæ7W7FöÖW%&öf–ÆRÀ¢7W7FöÖW$6&C ¢—FVÒæ7W7FöÖW$6&BÀ¢W‡—&W4C ¢—FVÒæW‡—&W4BÇÀ¢çVÆÂÀ¢GW&F–öåG—S ¢—FVÒæGW&F–öåG—RÇÀ¢çVÆÀ¢Ò¢Ğ¢“° ¢6öç7B7–æ6VBĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b€¢&W7öç6Ræö²b`¢7–æ6VBæ7F—fF–öå7FGW0¢’°¢—FVÒæ7F—fF–öå7FGW2Ğ¢7–æ6VBæ7F—fF–öå7FGW3°¢Ğ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–âFW7BÖævVB7F—fF–öâ7–æ2f–ÆVC¢"À¢W'&÷ ¢“°¢Ğ ¢FÖ–åFW7E6fU&VçFÇ2€¢&VçFÇ0¢“° ¢7FFRç&VçFVDÖVÖ&W'6†—2Ğ¢&VçFÇ3° ¢6öç7BÖævVDw&÷W÷VâĞ¢ÖævVE&öf–ÆW4w&÷W—4÷Vâ‚“° ¢&VæFW%&WF–ÆW%&öf–ÆW2‚“° ¢&W7F÷&TÖævVE&öf–ÆW4w&÷W÷Vâ€¢ÖævVDw&÷W÷Và¢“° ¢&WGW&ã°¢Ğ ¢G'’°¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢ö’ö66÷VçBöÖævVBÖÖVÖ&W'6†—2òG¶Væ6öFUU$”6ö×öæVçB€¢G—P¢—ÒòG¶Væ6öFUU$”6ö×öæVçB€¢76–væÖVçD–@¢—ÒöWFöf–ÆÆÀ¢°¢ÖWF†öC ¢%õ5B"À¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ¢&öG“ ¢¥4ôâç7G&–æv–g’‡°¢6†—–ætFG&W74–BÀ¢–ÖVçDÖWF†öD–@¢Ò¢Ğ¢“° ¢6öç7B&W7VÇBĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢&W7VÇBæW'&÷"ÇÀ¢%Væ&ÆRFòÇ’6fVB–æf÷&ÖF–öââ ¢“°¢Ğ ¢6öç7BÖævVDw&÷W÷VâĞ¢ÖævVE&öf–ÆW4w&÷W—4÷Vâ‚“° ¢v—BÆöDÖævVDÖVÖ&W'6†—2‚“° ¢&VæFW%&WF–ÆW%&öf–ÆW2‚“° ¢&W7F÷&TÖævVE&öf–ÆW4w&÷W÷Vâ€¢ÖævVDw&÷W÷Và¢“° ¢6öç7BÖævVD6&DÖW76vRĞ¢6&CòçVW'•6VÆV7F÷"€¢%¶FFÖÖævVBÖf÷&ÒÖÖW76vUÒ ¢“° ¢–b€¢ÖævVD6&DÖW76vP¢’°¢ÖævVD6&DÖW76vRçFW‡D6öçFVçBĞ¢&W7VÇBæÖW76vRÇÀ¢%6fVB–æf÷&ÖF–öâÆ–VBâ#° ¢ÖævVD6&DÖW76vRæ6Æ74æÖRĞ¢&ÖævVBÖf÷&ÒÖÖW76vR7V66W72#°¢Ğ ¢Ò6F6‚†W'&÷"’°¢6†÷t66÷VçDÖW76vR€¢W'&÷"æÖW76vRÀ¢&W'&÷" ¢“°¢Ğ§Ğ  ¦gVæ7F–öâ&–æDÖævVDWFöf–ÆÂ‚’°¢Fö7VÖVç@¢çVW'•6VÆV7F÷$ÆÂ€¢%¶FFÖÖævVBÖWFöf–ÆÂÖÇ•Ò ¢¢æf÷$V6‚†'WGFöâÓâ°¢'WGFöâæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6öç7B6&BĞ¢'WGFöâæ6Æ÷6W7B€¢%¶FFÖÖævVBÖ76–væÖVçEÒ ¢“° ¢Ç”ÖævVE6fVD–æfò€¢6&@¢“°¢Ğ¢“°¢Ò“°§Ğ  ¦gVæ7F–öâ&–æEW'6öæÅ&öf–ÆTWFöf–ÆÂ‚’°¢Fö7VÖVç@¢çVW'•6VÆV7F÷$ÆÂ€¢%¶FF×W'6öæÂÖWFöf–ÆÂÖf–ÆÅÒ ¢¢æf÷$V6‚†'WGFöâÓâ°¢'WGFöâæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6öç7B6&BĞ¢'WGFöâæ6Æ÷6W7B€¢%¶FF×&WF–ÆW"×&öf–ÆUÒ ¢“° ¢6öç7Bf÷&ÒĞ¢6&CòçVW'•6VÆV7F÷"€¢%¶FF×&WF–ÆW"×&öf–ÆRÖf÷&ÕÒ ¢“° ¢–b‚f÷&Ò’°¢&WGW&ã°¢Ğ ¢6öç7B6†—–æt–BĞ¢6&BçVW'•6VÆV7F÷"€¢%¶FF×W'6öæÂ×6†—–ær×6VÆV7EÒ ¢“òçfÇVRÇÂ"#° ¢6öç7B–ÖVçD–BĞ¢6&BçVW'•6VÆV7F÷"€¢%¶FF×W'6öæÂÖ6&B×6VÆV7EÒ ¢“òçfÇVRÇÂ"#° ¢–b€¢6†—–æt–Bb`¢–ÖVçD–@¢’°¢6†÷t66÷VçDÖW76vR€¢$6†ö÷6R6fVB6†—–ærFG&W72÷"6&Bf—'7Bâ"À¢&W'&÷" ¢“°¢&WGW&ã°¢Ğ ¢–b€¢f÷&ÒæVÆVÖVçG0¢ç6†—–ætFG&W74–@¢’°¢f÷&ÒæVÆVÖVçG0¢ç6†—–ætFG&W74–@¢çfÇVRĞ¢6†—–æt–C°¢Ğ ¢–b€¢f÷&ÒæVÆVÖVçG0¢ç–ÖVçDÖWF†öD–@¢’°¢f÷&ÒæVÆVÖVçG0¢ç–ÖVçDÖWF†öD–@¢çfÇVRĞ¢–ÖVçD–C°¢Ğ ¢6öç7BFG&W72Ğ¢6fVDFG&W74'”–B€¢6†—–æt–@¢“° ¢–b†FG&W72’°¢6öç7BfÇVW2Ò°¢f—'7DæÖS ¢FG&W72æf—'7DæÖRÇÀ¢""À¢Æ7DæÖS ¢FG&W72æÆ7DæÖRÇÀ¢""À¢FG&W73 ¢FG&W72æFG&W72ÇÀ¢""À¢FG&W73# ¢FG&W72æFG&W73"ÇÀ¢""À¢6—G“ ¢FG&W72æ6—G’ÇÀ¢""À¢7FFS ¢FG&W72ç7FFRÇÀ¢""À¢¦— ¢FG&W72ç¦—ÇÀ¢""À¢6÷VçG'“ ¢FG&W72æ6÷VçG'’ÇÀ¢%U2 ¢Ó° ¢ö&¦V7BæVçG&–W2€¢fÇVW0¢’æf÷$V6‚€¢…°¢¶W’À¢fÇVP¢Ò’Óâ°¢6öç7B–çWBĞ¢f÷&ÒæVÆVÖVçG5°¢¶W¢Ó° ¢–b†–çWB’°¢–çWBçfÇVRĞ¢fÇVS°¢Ğ¢Ğ¢“°¢Ğ ¢6öç7B–ÖVçBĞ¢6fVE–ÖVçD'”–B€¢–ÖVçD–@¢“° ¢–b‡–ÖVçB’°¢–b€¢f÷&ÒæVÆVÖVçG0¢æ6&DÆ&VÀ¢’°¢f÷&ÒæVÆVÖVçG0¢æ6&DÆ&VÀ¢çfÇVRĞ¢–ÖVçBæ6&DÆ&VÂÇÀ¢"#°¢Ğ ¢–b€¢f÷&ÒæVÆVÖVçG0¢æ6&F†öÆFW ¢’°¢f÷&ÒæVÆVÖVçG0¢æ6&F†öÆFW ¢çfÇVRĞ¢–ÖVçBæ6&F†öÆFW"ÇÀ¢"#°¢Ğ ¢–b€¢f÷&ÒæVÆVÖVçG0¢æW‡ÖöçF€¢’°¢f÷&ÒæVÆVÖVçG0¢æW‡ÖöçF€¢çfÇVRĞ¢–ÖVçBæW‡ÖöçF‚ÇÀ¢"#°¢Ğ ¢–b€¢f÷&ÒæVÆVÖVçG0¢æW‡–V ¢’°¢f÷&ÒæVÆVÖVçG0¢æW‡–V ¢çfÇVRĞ¢–ÖVçBæW‡–V"ÇÀ¢"#°¢Ğ ¢–b€¢f÷&ÒæVÆVÖVçG0¢æ6ô6&DçVÖ&W ¢’°¢f÷&ÒæVÆVÖVçG0¢æ6ô6&DçVÖ&W ¢çfÇVRĞ¢"#° ¢f÷&ÒæVÆVÖVçG0¢æ6ô6&DçVÖ&W ¢ç&WV—&VBĞ¢fÇ6S° ¢f÷&ÒæVÆVÖVçG0¢æ6ô6&DçVÖ&W ¢çÆ6V†öÆFW"Ğ¢–ÖVçBæÖ6¶VDçVÖ&W ¢ò6fVBG·–ÖVçBæÖ6¶VDçVÖ&W'Ò(	BÆVfR&Ææ²Fò¶VW ¢¢%6fVB6&B6VÆV7FVB#°¢Ğ ¢–b€¢f÷&ÒæVÆVÖVçG0¢ç6V7W&—G”6öFP¢’°¢f÷&ÒæVÆVÖVçG0¢ç6V7W&—G”6öFP¢çfÇVRĞ¢"#° ¢f÷&ÒæVÆVÖVçG0¢ç6V7W&—G”6öFP¢çÆ6V†öÆFW"Ğ¢%6fVB6öFR6VÆV7FVB(	BÆVfR&Ææ²Fò¶VW#°¢Ğ¢Ğ ¢6öç7B&öG’Ğ¢6&BçVW'•6VÆV7F÷"€¢%¶FF×&öf–ÆRÖ&öG•Ò ¢“° ¢–b€¢&öG’b`¢&öG’æ†–FFVà¢’°¢&öG’æ†–FFVâĞ¢fÇ6S° ¢6&Bæ6Æ74Æ—7BæFB€¢&W‡æFVB ¢“° ¢6&@¢çVW'•6VÆV7F÷"€¢%¶FF×&öf–ÆR×FövvÆUÒ ¢¢òç6WDGG&–'WFR€¢&&–ÖW‡æFVB"À¢'G'VR ¢“°¢Ğ ¢6†÷t66÷VçDÖW76vR€¢%6fVB–æf÷&ÖF–öâf–ÆÆVB–çFòF†—2&öf–ÆRâ&Wf–Wr—BÂF†Vâ6Æ–6²6fR&öf–ÆRâ"À¢'7V66W72 ¢“°¢Ğ¢“°¢Ò“°§Ğ ¦gVæ7F–öâ&–æDÖævVDÖVÖ&W'6†—f÷&×2‚’°¢Fö7VÖVç@¢çVW'•6VÆV7F÷$ÆÂ€¢%¶FFÖÖævVBÖ7W7FöÖW"Öf÷&ÕÒ ¢¢æf÷$V6‚†f÷&ÒÓâ° ¢6öç7BFG&W756VÆV7BĞ¢f÷&ÒçVW'•6VÆV7F÷"€¢%¶FFÖÖævVBÖFG&W72×6÷W&6UÒ ¢“° ¢FG&W756VÆV7@¢òæFDWfVçDÆ—7FVæW"€¢&6†ævR"À¢‚’Óâ°¢6öç7B÷&FW$çVÖ&W"Ğ¢FG&W756VÆV7BçfÇVS° ¢–b€¢÷&FW$çVÖ&W"ÇÀ¢÷&FW$çVÖ&W"ÓÓÒ&7W'&VçB ¢’°¢&WGW&ã°¢Ğ ¢6öç7B÷&FW"Ğ¢7FFRæ÷&FW'2æf–æB€¢—FVÒÓà¢7G&–ær€¢vWD÷&FW$çVÖ&W"†—FVÒ¢’ÓÓĞ¢7G&–ær†÷&FW$çVÖ&W"¢“° ¢–b‚÷&FW"’°¢&WGW&ã°¢Ğ ¢6öç7B&öf–ÆRĞ¢vWD÷&FW%&öf–ÆR€¢÷&FW ¢“° ¢f÷"€¢6öç7Bf–VÆDæÖRöb°¢&f—'7DæÖR"À¢&Æ7DæÖR"À¢&VÖ–Â"À¢'†öæR"À¢&FG&W72"À¢&FG&W73""À¢&6—G’"À¢'7FFR"À¢'¦—"À¢&6÷VçG'’ ¢Ğ¢’°¢6öç7B–çWBĞ¢f÷&ÒæVÆVÖVçG5°¢f–VÆDæÖP¢Ó° ¢–b†–çWB’°¢–çWBçfÇVRĞ¢&öf–ÆSòå°¢f–VÆDæÖP¢ÒÇÂ"#°¢Ğ¢Ğ¢Ğ¢“°  ¢f÷&ÒæFDWfVçDÆ—7FVæW"€¢'7V&Ö—B"À¢7–æ2WfVçBÓâ°¢WfVçBç&WfVçDFVfVÇB‚“° ¢6öç7B76–væÖVçD–BĞ¢f÷&ÒæFF6W@¢æÖævVD7W7FöÖW$f÷&Ó° ¢6öç7BG—RĞ¢f÷&ÒæFF6W@¢æÖævVEG—S° ¢–b‚76–væÖVçD–B’°¢6†÷t66÷VçDÖW76vR€¢%F†—2ÖævVBÖVÖ&W'6†——2Ö—76–ær—G276–væÖVçB”Bâ"À¢&W'&÷" ¢“°¢&WGW&ã°¢Ğ ¢6öç7B'WGFöâĞ¢f÷&ÒçVW'•6VÆV7F÷"€¢v'WGFöå·G—SÒ'7V&Ö—B%Òp¢“° ¢6öç7BÖW76vRĞ¢Fö7VÖVçBçVW'•6VÆV7F÷"€¢¶FFÖÖævVBÖ7W7FöÖW"ÖÖW76vSÒ"G´552æW66R€¢76–væÖVçD–@¢—Ò%Ö ¢“° ¢6öç7Bf÷&ÔFFĞ¢æWrf÷&ÔFF†f÷&Ò“° ¢6öç7B7W7FöÖW%&öf–ÆRÒ°¢&öf–ÆTæÖS ¢G¶f÷&ÔFFævWB‚&f—'7DæÖR"’ÇÂ"'ÒG¶f÷&ÔFFævWB‚&Æ7DæÖR"’ÇÂ"'ÖçG&–Ò‚’ÇÀ¢$ÖævVBÖVÖ&W'6†—"À ¢f—'7DæÖS ¢f÷&ÔFFævWB‚&f—'7DæÖR"’ÇÂ""À ¢Æ7DæÖS ¢f÷&ÔFFævWB‚&Æ7DæÖR"’ÇÂ""À ¢VÖ–Ã ¢f÷&ÔFFævWB‚&VÖ–Â"’ÇÂ""À ¢†öæS ¢f÷&ÔFFævWB‚'†öæR"’ÇÂ""À ¢FG&W73 ¢f÷&ÔFFævWB‚&FG&W72"’ÇÂ""À ¢FG&W73# ¢f÷&ÔFFævWB‚&FG&W73""’ÇÂ""À ¢6—G“ ¢f÷&ÔFFævWB‚&6—G’"’ÇÂ""À ¢7FFS ¢f÷&ÔFFævWB‚'7FFR"’ÇÂ""À ¢¦— ¢f÷&ÔFFævWB‚'¦—"’ÇÂ""À ¢6÷VçG'“ ¢f÷&ÔFFævWB‚&6÷VçG'’"’ÇÂ" ¢Ó° ¢6öç7B7W7FöÖW$6&BÒ°¢6&DÆ&VÃ ¢f÷&ÔFFævWB‚&6&DÆ&VÂ"’ÇÂ""À ¢6&F†öÆFW# ¢f÷&ÔFFævWB‚&6&F†öÆFW""’ÇÂ""À ¢6ô6&DçVÖ&W# ¢f÷&ÔFFævWB‚&6ô6&DçVÖ&W""’ÇÂ""À ¢W‡ÖöçFƒ ¢f÷&ÔFFævWB‚&W‡ÖöçF‚"’ÇÂ""À ¢W‡–V# ¢f÷&ÔFFævWB‚&W‡–V""’ÆÚ±î¸Â¸­yêë¢°k¢G§¦*^| "",

            securityCode:
              formData.get("securityCode") || ""
          };

          setButtonBusy(
            button,
            true,
            "Savingâ€¦"
          );

          if (
            ADMIN_PREVIEW_MODE
          ) {
            try {
              const rentals =
                adminTestReadRentals();

              const item =
                rentals.find(
                  rental =>
                    String(
                      rental.assignmentId
                    ) ===
                    String(
                      assignmentId
                    )
                );

              if (!item) {
                throw new Error(
                  "This test rental could not be found."
                );
              }

              item.customerProfile =
                customerProfile;

              item.customerCard =
                customerCard;

              adminTestSaveRentals(
                rentals
              );

              state.rentedMemberships =
                rentals;

              setMessage(
                message,
                "Test customer address and card information saved locally.",
                "success"
              );

              renderRetailerProfiles();

            } catch (error) {
              setMessage(
                message,
                error.message,
                "error"
              );

            } finally {
              setButtonBusy(
                button,
                false
              );
            }

            return;
          }

          try {
            const response =
              await fetch(
                `/api/account/managed-memberships/${encodeURIComponent(
                  type
                )}/${encodeURIComponent(
                  assignmentId
                )}`,
                {
                  method: "PUT",

                  credentials:
                    "same-origin",

                  headers: {
                    "Content-Type":
                      "application/json"
                  },

                  body:
                    JSON.stringify({
                      customerProfile,
                      customerCard
                    })
                }
              );

            const result =
              await readJson(
                response
              );

            if (!response.ok) {
              throw new Error(
                result.error ||
                "Unable to save managed membership details."
              );
            }

            setMessage(
              message,
              "Address and card information saved.",
              "success"
            );

            await loadManagedMemberships();

            renderRetailerProfiles();

          } catch (error) {
            setMessage(
              message,
              error.message,
              "error"
            );

          } finally {
            setButtonBusy(
              button,
              false
            );
          }
        }
      );
    });
}


function bindRetailerPasswordToggles() {
  document
    .querySelectorAll(
      "[data-retailer-password-toggle]"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          const wrapper =
            button.closest(
              ".retailer-password-input-wrap"
            );

          const input =
            wrapper?.querySelector(
              'input[type="password"], input[type="text"]'
            );

          if (!input) {
            return;
          }

          const showing =
            input.type === "text";

          input.type =
            showing
              ? "password"
              : "text";

          button.textContent =
            showing
              ? "Show"
              : "Hide";

          button.setAttribute(
            "aria-label",
            showing
              ? "Show password"
              : "Hide password"
          );
        }
      );
    });
}


function bindRetailerProfileForms() {
  document
    .querySelectorAll(
      "[data-retailer-profile-form]"
    )
    .forEach(form => {
      form.addEventListener(
        "submit",
        saveRetailerProfile
      );
    });
}

function bindSpecialProfileForms() {
  document
    .querySelectorAll(
      "[data-special-profile-form]"
    )
    .forEach(form => {
      form.addEventListener(
        "submit",
        saveSpecialProfile
      );
    });
}

function renderRetailerProfiles() {

  const container =
    document.getElementById(
      "retailer-profiles"
    );


  const activeBadge =
    document.getElementById(
      "retailer-profiles-active"
    );


  const availableBadge =
    document.getElementById(
      "retailer-profiles-available"
    );


  const mainMessage =
    document.getElementById(
      "retailer-profile-message"
    );


  if (!container) {
    return;
  }


  /*
    Get the number of profiles allowed
    by the customer's current membership.
  */

  const allowance =
    Math.max(
      0,
      Number(
        state.retailerAllowance
      ) || 0
    );


  /*
    Count the saved profiles that are
    currently inside the customer's
    active membership allowance.

    Profiles saved above the current
    allowance remain stored, but they
    are locked and are NOT counted as
    active.
  */

  const activeProfiles =
    state.retailerProfiles.filter(
      profile => {

        const slot =
          Number(
            profile?.slot
          ) || 0;

        return (
          slot >= 1 &&
          slot <= allowance
        );
      }
    ).length;


  /*
    Calculate the number of unused
    profile slots still available.
  */

  const availableProfiles =
    Math.max(
      0,
      allowance - activeProfiles
    );


  /*
    PROFILES ACTIVE

    Show only the number.

    The CSS class makes the number
    green whenever at least one
    profile is active.
  */

  if (activeBadge) {

    activeBadge.textContent =
      String(activeProfiles);

    activeBadge.classList.toggle(
      "has-active-profiles",
      activeProfiles > 0
    );
  }


  /*
    PROFILES AVAILABLE

    Show only the number.
  */

  if (availableBadge) {

    availableBadge.textContent =
      String(availableProfiles);
  }


  /*
    No active membership.
  */

if (allowance <= 0) {

  const freeCards =
  state.freeMemberships
    .map(
      membership =>
        managedMembershipCardHtml(
          membership
        )
    )
    .filter(Boolean);

const rentedCards =
  state.rentedMemberships
    .map(
      membership =>
        managedMembershipCardHtml(
          membership
        )
    )
    .filter(Boolean);

const specialCards =
  [
    ...freeCards,
    ...rentedCards
  ];

  container.innerHTML = `
    ${
      specialCards.length
        ? `
            <details
              class="profile-group-dropdown special-profile-category"
            >
              <summary>
                <div>
                  <span class="eyebrow">
                    MANAGED ACO ACCESS
                  </span>

                  <strong>
                    Gifted Profiles &amp; Rented Profiles
                  </strong>
                </div>

                <span
                  class="profile-group-open"
                  data-profile-group-label
                  data-show-text="SHOW ALL GIFTED & RENTED PROFILES"
                  data-hide-text="HIDE ALL GIFTED & RENTED PROFILES"
                >
                  SHOW ALL GIFTED &amp; RENTED PROFILES
                </span>
              </summary>

              <div
                class="profile-group-dropdown-body"
              >
                ${specialCards.join("")}
              </div>
            </details>
          `
        : `
            <div
              class="retailer-profile-placeholder"
            >

              <div
                class="retailer-profile-placeholder-icon"
              >
                ğŸ”’
              </div>

              <h3>
                Active membership required
              </h3>

              <p>
                Once an active membership is
                connected to this account, your
                retailer profile slots will appear
                here automatically.
              </p>

              <button
                type="button"
                class="primary"
                id="retailer-view-memberships"
              >
                View Memberships
              </button>

            </div>
          `
    }
  `;

  if (!specialCards.length) {
    document
      .getElementById(
        "retailer-view-memberships"
      )
      ?.addEventListener(
        "click",
        () => {
          go("pricing");
        }
      );
  }

  bindRetailerPasswordToggles();

  bindSpecialProfileForms();

  bindManagedMembershipForms();
  bindProfileAccordions();
  bindManagedAutofill();
  bindPersonalProfileAutofill();

  if (mainMessage) {
    setMessage(
      mainMessage,
      ""
    );
  }

  return;
}


  /*
    Normally we display the customer's
    current allowance.

    If they previously had a larger
    membership, saved profiles above
    their current allowance are also
    displayed as locked so their data
    is never silently lost.
  */

  const highestSavedSlot =
    state.retailerProfiles.reduce(
      (highest, profile) =>
        Math.max(
          highest,
          Number(
            profile.slot
          ) || 0
        ),
      0
    );


  const totalSlots =
    Math.min(
      50,
      Math.max(
        allowance,
        highestSavedSlot
      )
    );


  const cards = [];


  for (
    let slot = 1;
    slot <= totalSlots;
    slot += 1
  ) {

    cards.push(
      retailerProfileCardHtml(
        slot,
        getRetailerProfileBySlot(
          slot
        )
      )
    );
  }


  let missingPaidProfileCount =
    0;

  for (
    let slot = 1;
    slot <= allowance;
    slot += 1
  ) {
    const savedProfile =
      getRetailerProfileBySlot(
        slot
      );

    const readiness =
      savedProfile?.readiness ||
      profileReadiness(
        savedProfile?.customerProfile ||
        {},
        savedProfile?.customerCard ||
        {}
      );

    if (
      readiness?.ready !==
        true
    ) {
      missingPaidProfileCount +=
        1;
    }
  }


  const freeManagedCards =
    state.freeMemberships
      .map(
        membership =>
          managedMembershipCardHtml(
            membership
          )
      )
      .filter(Boolean);

  const rentedManagedCards =
    state.rentedMemberships
      .map(
        membership =>
          managedMembershipCardHtml(
            membership
          )
      )
      .filter(Boolean);

  const specialCards = [
    ...freeManagedCards,
    ...rentedManagedCards
  ];

container.innerHTML = `
  ${
    cards.length
      ? `
          <details
            class="profile-group-dropdown"
          >
            <summary>
              <div>
                <span class="eyebrow">
                  PAID ACO ACCESS
                </span>

                <strong>
                  Paid Profiles
                </strong>

                <span
                  class="paid-profile-missing-tracker ${
                    missingPaidProfileCount
                      ? "has-missing"
                      : "complete"
                  }"
                >
                  ${
                    missingPaidProfileCount
                      ? `${missingPaidProfileCount} ${
                          missingPaidProfileCount === 1
                            ? "PROFILE"
                            : "PROFILES"
                        } MISSING INFORMATION`
                      : "ALL PAID PROFILES COMPLETE"
                  }
                </span>
              </div>

              <span
                class="profile-group-open"
                data-profile-group-label
                data-show-text="SHOW ALL PAID PROFILES"
                data-hide-text="HIDE ALL PAID PROFILES"
              >
                SHOW ALL PAID PROFILES
              </span>
            </summary>

            <div
              class="profile-group-dropdown-body"
            >
              ${cards.join("")}
            </div>
          </details>
        `
      : ""
  }

  ${
    specialCards.length
      ? `
          <details
            class="profile-group-dropdown special-profile-category"
          >
            <summary>
              <div>
                <span class="eyebrow">
                  MANAGED ACO ACCESS
                </span>

                <strong>
                  Gifted Profiles &amp; Rented Profiles
                </strong>
              </div>

              <span
                class="profile-group-open"
                data-profile-group-label
                data-show-text="SHOW ALL GIFTED & RENTED PROFILES"
                data-hide-text="HIDE ALL GIFTED & RENTED PROFILES"
              >
                SHOW ALL GIFTED &amp; RENTED PROFILES
              </span>
            </summary>

            <div
              class="profile-group-dropdown-body"
            >
              ${specialCards.join("")}
            </div>
          </details>
        `
      : ""
  }
`;


  bindRetailerPasswordToggles();

  bindRetailerProfileForms();

  bindSpecialProfileForms();

  bindManagedMembershipForms();

  bindProfileGroupDropdowns();

  bindProfileAccordions();

  bindPaidProfileSubsections();

  bindManagedAutofill();

  bindPersonalProfileAutofill();


  if (mainMessage) {

    setMessage(
      mainMessage,
      ""
    );
  }
}
  


async function loadRetailerProfiles(
  force = false
) {
  if (ADMIN_PREVIEW_MODE) {
    try {
      const response =
        await fetch(
          "/api/admin/test-profile-workflow",
          {
            method: "GET",
            credentials:
              "same-origin",
            cache:
              "no-store"
          }
        );

      const data =
        await readJson(
          response
        );

      if (response.ok) {
        state.retailerProfiles =
          Array.isArray(
            data.profiles
          )
            ? data.profiles
            : [];
      }
    } catch (error) {
      console.error(
        "Admin Test Customer profile load failed:",
        error
      );
    }

    state.specialProfiles = [];
    state.retailerProfilesLoaded = true;
    renderRetailerProfiles();
    return;
  }
  if (
    state.retailerProfilesLoaded &&
    !force
  ) {
    renderRetailerProfiles();
    return;
  }

  const container =
    document.getElementById(
      "retailer-profiles"
    );

  const message =
    document.getElementById(
      "retailer-profile-message"
    );

  if (container) {
    container.innerHTML = `
      <div
        class="retailer-profile-placeholder"
      >
        <div
          class="retailer-profile-placeholder-icon"
        >
          â€¦
        </div>

        <h3>
          Loading your profiles
        </h3>

        <p>
          Your secure retailer profile
          information is loading.
        </p>
      </div>
    `;
  }

  setMessage(
    message,
    ""
  );

  try {
    const response =
      await fetch(
        "/api/account/retailer-profiles",
        {
          method: "GET",

          credentials:
            "same-origin",

          cache:
            "no-store"
        }
      );

    const data =
      await readJson(
        response
      );

    if (
      response.status === 401
    ) {
      state.retailerProfiles = [];
state.specialProfiles = [];
state.retailerAllowance = 0;
state.retailerProfilesLoaded =
  false;

      return;
    }

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Unable to load your retailer profiles."
      );
    }

    state.retailerAllowance =
      Math.max(
        0,
        Number(
          data.allowance
        ) || 0
      );

    state.retailerProfiles =
  Array.isArray(
    data.profiles
  )
    ? data.profiles
    : [];

state.specialProfiles =
  Array.isArray(
    data.specialProfiles
  )
    ? data.specialProfiles
    : [];

    state.retailerProfilesLoaded =
      true;

    renderRetailerProfiles();

  } catch (error) {
    state.retailerProfilesLoaded =
      false;

    setMessage(
      message,
      error.message,
      "error"
    );

    if (container) {
      container.innerHTML = `
        <div
          class="retailer-profile-placeholder"
        >
          <h3>
            Profiles could not be loaded
          </h3>

          <p>
            ${escapeHtml(
              error.message
            )}
          </p>

          <button
            type="button"
            class="secondary"
            id="retry-retailer-profiles"
          >
            Try Again
          </button>
        </div>
      `;

      document
        .getElementById(
          "retry-retailer-profiles"
        )
        ?.addEventListener(
          "click",
          () => {
            loadRetailerProfiles(
              true
            );
          }
        );
    }
  }
}

async function loadManagedMemberships() {
  if (ADMIN_PREVIEW_MODE) {
    state.freeMemberships = [];

    let workflowStatuses = [];

    try {
      const response =
        await fetch(
          "/api/admin/test-managed-profile-workflow",
          {
            method: "GET",
            credentials:
              "same-origin",
            cache:
              "no-store"
          }
        );

      const data =
        await readJson(
          response
        );

      if (
        response.ok &&
        Array.isArray(
          data.profiles
        )
      ) {
        workflowStatuses =
          data.profiles;
      }
    } catch (error) {
      console.error(
        "Admin test managed profile status load failed:",
        errorÚ±î¸Â¸­yêë¢°k¢G§¦*^¢“°¢Ğ ¢7FFRç&VçFVDÖVÖ&W'6†—2Ğ¢FÖ–åFW7E&VE&VçFÇ2‚¢æÖ†—FVÒÓâ°¢6öç7Bv÷&¶fÆ÷rĞ¢v÷&¶fÆ÷u7FGW6W2æf–æB€¢&öf–ÆRÓà¢7G&–ær€¢&öf–ÆRæ76–væÖVçD–@¢’ÓÓĞ¢7G&–ær€¢—FVÒæ76–væÖVçD–@¢’b`¢&öf–ÆRçG—RÓÓĞ¢'&VçFVB ¢“° ¢&WGW&â°¢ââæ—FVÒÀ ¢7F—fF–öå7FGW3 ¢v÷&¶fÆ÷p¢òæ7F—fF–öå7FGW2ÇÀ¢—FVÒæ7F—fF–öå7FGW2ÇÀ¢&–æ6ö×ÆWFR"À ¢7F—fF–öäÆ&VÃ ¢v÷&¶fÆ÷p¢òæ7F—fF–öäÆ&VÂÇÀ¢—FVÒæ7F—fF–öäÆ&VÂÇÀ¢çVÆÂÀ ¢F—5&VÖ–æ–æs ¢—FVÒæW‡—&W4@¢òFÖ–åFW7DF—5&VÖ–æ–ær€¢—FVÒæW‡—&W4@¢¢¢çVÆÀ¢Ó°¢Ò¢æf–ÇFW"†—FVÒÓà¢—FVÒæW‡—&W4BÇÀ¢æWrFFR€¢—FVÒæW‡—&W4@¢’ævWEF–ÖR‚’à¢FFRææ÷r‚’ÇÀ¢—FVÒæ7F—fF–öå7FGW2ÓÓĞ¢&W‡—&VB ¢“° ¢FÖ–åFW7E6fU&VçFÇ2€¢7FFRç&VçFVDÖVÖ&W'6†—0¢“° ¢&VæFW%&WF–ÆW%&öf–ÆW2‚“° ¢&WGW&ã°¢Ğ¢G'’°¢6öç7B°¢g&VU&W7öç6RÀ¢&VçFVE&W7öç6P¢ÒÒv—B&öÖ—6RæÆÂ…°¢fWF6‚€¢"ö’ö66÷VçBög&VRÖÖVÖ&W'6†—2"À¢°¢ÖWF†öC¢$tUB"À¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À¢66†S ¢&æò×7F÷&R ¢Ğ¢’À ¢fWF6‚€¢"ö’ö66÷VçB÷&VçFVBÖÖVÖ&W'6†—2"À¢°¢ÖWF†öC¢$tUB"À¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À¢66†S ¢&æò×7F÷&R ¢Ğ¢¢Ò“° ¢–b€¢g&VU&W7öç6Rç7FGW2ÓÓÒCÇÀ¢&VçFVE&W7öç6Rç7FGW2ÓÓÒC¢’°¢7FFRæg&VTÖVÖ&W'6†—2ÒµÓ°¢7FFRç&VçFVDÖVÖ&W'6†—2ÒµÓ°¢&WGW&ã°¢Ğ ¢6öç7Bg&VTFFĞ¢v—B&VD§6öâ€¢g&VU&W7öç6P¢“° ¢6öç7B&VçFVDFFĞ¢v—B&VD§6öâ€¢&VçFVE&W7öç6P¢“° ¢–b‚g&VU&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢g&VTFFæW'&÷"ÇÀ¢%Væ&ÆRFòÆöBv–gFVB&öf–ÆW2â ¢“°¢Ğ ¢–b‚&VçFVE&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢&VçFVDFFæW'&÷"ÇÀ¢%Væ&ÆRFòÆöB&VçFVB&öf–ÆW2â ¢“°¢Ğ ¢7FFRæg&VTÖVÖ&W'6†—2Ğ¢'&’æ—4'&’€¢g&VTFFæÖVÖ&W'6†—0¢¢òg&VTFFæÖVÖ&W'6†—0¢¢µÓ° ¢7FFRç&VçFVDÖVÖ&W'6†—2Ğ¢'&’æ—4'&’€¢&VçFVDFFæÖVÖ&W'6†—0¢¢ò&VçFVDFFæÖVÖ&W'6†—0¢¢µÓ° ¢Ò6F6‚†W'&÷"’°¢7FFRæg&VTÖVÖ&W'6†—2ÒµÓ°¢7FFRç&VçFVDÖVÖ&W'6†—2ÒµÓ° ¢6öç6öÆRæW'&÷"€¢$ÖævVBÖVÖ&W'6†—ÆöBW'&÷#¢"À¢W'&÷ ¢“°¢Ğ§Ğ   ¦7–æ2gVæ7F–öâÆöDÖævVDf–Æ&–Æ—G”7W7FöÖW"‚’°¢6öç7BWFFVBĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öf–Æ&–Æ—G’×WFFVB ¢“° ¢G'’°¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’öÖævVBÖf–Æ&–Æ—G’"À¢°¢ÖWF†öC¢$tUB"À¢66†S¢&æò×7F÷&R ¢Ğ¢“° ¢6öç7BFFĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢FFæW'&÷"ÇÀ¢%Væ&ÆRFòÆöBf–Æ&–Æ—G’â ¢“°¢Ğ ¢7FFRæÖævVDf–Æ&–Æ—G’Ğ¢FF° ¢6öç7BfÇVW2Ò°¢&7W7FöÖW"×F&vWBÖf–Æ&ÆR# ¢FFçF&vWCòæf–Æ&ÆRÀ¢&7W7FöÖW"×F&vWBÖ–â×W6R# ¢FFçF&vWCòæ–åW6RÀ¢&7W7FöÖW"×F&vWB×F÷FÂ# ¢FFçF&vWCòçF÷FÂÀ¢&7W7FöÖW"×vÆÖ'BÖf–Æ&ÆR# ¢FFçvÆÖ'Còæf–Æ&ÆRÀ¢&7W7FöÖW"×vÆÖ'BÖ–â×W6R# ¢FFçvÆÖ'Còæ–åW6RÀ¢&7W7FöÖW"×vÆÖ'B×F÷FÂ# ¢FFçvÆÖ'CòçF÷FÀ¢Ó° ¢f÷"€¢6öç7B°¢–BÀ¢fÇVP¢Òöbö&¦V7BæVçG&–W2€¢fÇVW0¢¢’°¢6öç7BVÆVÖVçBĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢–@¢“° ¢–b†VÆVÖVçB’°¢VÆVÖVçBçFW‡D6öçFVçBĞ¢fÇVRóò.(	B#°¢Ğ¢Ğ ¢WFFU&VçFÅ7Fö6´6&B€¢'F&vWB"À¢FFçF&vW@¢“° ¢WFFU&VçFÅ7Fö6´6&B€¢'vÆÖ'B"À¢FFçvÆÖ'@¢“° ¢WFFU&VçFÅ&–6TF—7Æ’‚“° ¢–b‡WFFVB’°¢WFFVBçFW‡D6öçFVçBĞ¢%WFFVB§W7Bæ÷r#°¢Ğ ¢Ò6F6‚†W'&÷"’°¢7FFRæÖævVDf–Æ&–Æ—G’Ğ¢çVÆÃ° ¢–b‡WFFVB’°¢WFFVBçFW‡D6öçFVçBĞ¢%Væ&ÆRFòÆöB#°¢Ğ ¢6öç6öÆRæW'&÷"€¢$ÖævVBf–Æ&–Æ—G’ÆöBW'&÷#¢"À¢W'&÷ ¢“°¢Ğ§Ğ  ¥°¢'&VçFÂ×&WF–ÆW""À¢'&VçFÂÖ66÷VçB×VçF—G’"À¢'&VçFÂÖGW&F–öâ ¥Òæf÷$V6‚†–BÓâ°¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B†–B¢òæFDWfVçDÆ—7FVæW"€¢&6†ævR"À¢WFFU&VçFÅ&–6TF—7Æ¢“°§Ò“° ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'&VçFÂÖFB×FòÖ6'B ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢FE&VçFÅFô6'@¢“°    ¦gVæ7F–öâ–E&öf–ÆW4w&÷W—4÷Vâ‚’°¢6öç7Bw&÷WĞ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'&WF–ÆW"×&öf–ÆW2 ¢¢òçVW'•6VÆV7F÷"€¢"ç&öf–ÆRÖw&÷WÖG&÷F÷vâ ¢“° ¢&WGW&â&ööÆVâ€¢w&÷Wòæ÷Và¢“°§Ğ  ¦gVæ7F–öâ&W7F÷&U–E&öf–ÆW4w&÷W÷Vâ€¢6†÷VÆD÷Và¢’°¢–b‚6†÷VÆD÷Vâ’°¢&WGW&ã°¢Ğ ¢6öç7Bw&÷WĞ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'&WF–ÆW"×&öf–ÆW2 ¢¢òçVW'•6VÆV7F÷"€¢"ç&öf–ÆRÖw&÷WÖG&÷F÷vâ ¢“° ¢–b‚w&÷W’°¢&WGW&ã°¢Ğ ¢w&÷Wæ÷VâĞ¢G'VS° ¢6öç7BÆ&VÂĞ¢w&÷WçVW'•6VÆV7F÷"€¢%¶FF×&öf–ÆRÖw&÷WÖÆ&VÅÒ ¢“° ¢–b†Æ&VÂ’°¢Æ&VÂçFW‡D6öçFVçBĞ¢Æ&VÂæFF6W@¢æ†–FUFW‡BÇÀ¢$„”DRÄÂ”B$ôd”ÄU2#°¢Ğ§Ğ  ¦7–æ2gVæ7F–öâ6fU&WF–ÆW%&öf–ÆR€¢WfVç@¢’°¢WfVçBç&WfVçDFVfVÇB‚“° ¢6öç7Bf÷&ÒĞ¢WfVçBæ7W'&VçEF&vWC° ¢6öç7B6Æ÷BĞ¢çVÖ&W"€¢f÷&ÒæFF6W@¢ç&WF–ÆW%&öf–ÆTf÷&Ğ¢“° ¢6öç7BÖW76vRĞ¢Fö7VÖVçBçVW'•6VÆV7F÷"€¢¶FF×&WF–ÆW"×&öf–ÆRÖÖW76vSÒ"G·6Æ÷GÒ%Ö ¢“° ¢6öç7B'WGFöâĞ¢f÷&ÒçVW'•6VÆV7F÷"€¢v'WGFöå·G—SÒ'7V&Ö—B%Òp¢“° ¢–b€¢çVÖ&W"æ—4–çFVvW"‡6Æ÷B’ÇÀ¢6Æ÷BÂÇÀ¢6Æ÷BâS ¢’°¢6WDÖW76vR€¢ÖW76vRÀ¢$–çfÆ–B&öf–ÆR6Æ÷Bâ"À¢&W'&÷" ¢“° ¢&WGW&ã°¢Ğ ¢–b€¢6Æ÷Bà¢7FFRç&WF–ÆW$ÆÆ÷væ6P¢’°¢6WDÖW76vR€¢ÖW76vRÀ¢%F†—2&öf–ÆR—2æ÷Bf–Æ&ÆRv—F‚–÷W"7W'&VçBÖVÖ&W'6†—â"À¢&W'&÷" ¢“° ¢&WGW&ã°¢Ğ ¢6öç7Bf÷&ÔFFĞ¢æWrf÷&ÔFF†f÷&Ò“° ¢6öç7B&öf–ÆTæÖRĞ¢7G&–ær€¢f÷&ÔFFævWB€¢'&öf–ÆTæÖR ¢’ÇÂ" ¢’çG&–Ò‚“° ¢–b‚&öf–ÆTæÖR’°¢6WDÖW76vR€¢ÖW76vRÀ¢$VçFW"&öf–ÆRæÖRâ"À¢&W'&÷" ¢“° ¢&WGW&ã°¢Ğ ¢6öç7B6†—–ætFG&W74–BĞ¢7G&–ær€¢f÷&ÔFFævWB€¢'6†—–ætFG&W74–B ¢’ÇÂ" ¢’çG&–Ò‚“° ¢6öç7B–ÖVçDÖWF†öD–BĞ¢7G&–ær€¢f÷&ÔFFævWB€¢'–ÖVçDÖWF†öD–B ¢’ÇÂ" ¢’çG&–Ò‚“° ¢6öç7B7W7FöÖW%&öf–ÆRÒ°¢&öf–ÆTæÖRÀ ¢f—'7DæÖS ¢7G&–ær€¢f÷&ÔFFævWB€¢&f—'7DæÖR ¢’ÇÂ" ¢’çG&–Ò‚’À ¢Æ7DæÖS ¢7G&–ær€¢f÷&ÔFFævWB€¢&Æ7DæÖR ¢’ÇÂ" ¢’çG&–Ò‚’À ¢VÖ–Ã ¢7G&–ær€¢f÷&ÔFFævWB€¢&VÖ–Â ¢’ÇÂ" ¢’çG&–Ò‚’À ¢†öæS ¢7G&–ær€¢f÷&ÔFFævWB€¢'†öæR ¢’ÇÂ" ¢’çG&–Ò‚’À ¢FG&W73 ¢7G&–ær€¢f÷&ÔFFævWB€¢&FG&W72 ¢’ÇÂ" ¢’çG&–Ò‚’À ¢FG&W73# ¢7G&–ær€¢f÷&ÔFFævWB€¢&FG&W73" ¢’ÇÂ" ¢’çG&–Ò‚’À ¢6—G“ ¢7G&–ær€¢f÷&ÔFFævWB€¢&6—G’ ¢’ÇÂ" ¢’çG&–Ò‚’À ¢7FFS ¢7G&–ær€¢f÷&ÔFFævWB€¢'7FFR ¢’ÇÂ" ¢’çG&–Ò‚’À ¢¦— ¢7G&–ær€¢f÷&ÔFFævWB€¢'¦— ¢’ÇÂ" ¢’çG&–Ò‚’À ¢6÷VçG'“ ¢7G&–ær€¢f÷&ÔFFævWB€¢&6÷VçG'’ ¢’ÇÂ" ¢’çG&–Ò‚¢Ó° ¢6öç7B7W7FöÖW$6&BÒ°¢6&DÆ&VÃ ¢7G&–ær€¢f÷&ÔFFævWB€¢&6&DÆ&VÂ ¢’ÇÂ" ¢’çG&–Ò‚’À ¢6&F†öÆFW# ¢7G&–ær€¢f÷&ÔFFævWB€¢&6&F†öÆFW" ¢’ÇÂ" ¢’çG&–Ò‚’À ¢6ô6&DçVÖ&W# ¢7G&–ær€¢f÷&ÔFFævWB€¢&6ô6&DçVÖ&W" ¢’ÇÂ" ¢’çG&–Ò‚’À ¢W‡ÖöçFƒ ¢7G&–ær€¢f÷&ÔFFævWB€¢&W‡ÖöçF‚ ¢’ÇÂ" ¢’çG&–Ò‚’À ¢W‡–V# ¢7G&–ær€¢f÷&ÔFFævWB€¢&W‡–V" ¢’ÇÂ" ¢’çG&–Ò‚’À ¢6V7W&—G”6öFS ¢7G&–ær€¢f÷&ÔFFævWB€¢'6V7W&—G”6öFR ¢’ÇÂ" ¢’çG&–Ò‚¢Ó° ¢6öç7B&WF–ÆW'2Ò·Ó° ¢f÷"€¢6öç7B&WF–ÆW"ö`¢$UD”ÄU%0¢’°¢&WF–ÆW'5°¢&WF–ÆW"æ¶W¢ÒÒ°¢W6W&æÖS ¢7G&–ær€¢f÷&ÔFFævWB€¢G·&WF–ÆW"æ¶W—ÕW6W&æÖV ¢’ÇÂ" ¢’çG&–Ò‚’À ¢ò ¢&Ææ²77v÷&B–çFVçF–öæÆÇ’FVÆÇ0¢F†R6W'fW"Fò&WF–âF†RVæ7'—FV@¢77v÷&BÇ&VG’öâf–ÆRà¢¢ğ ¢77v÷&C ¢7G&–ær€¢f÷&ÔFFævWB€¢G·&WF–ÆW"æ¶W—Õ77v÷&F ¢’ÇÂ" ¢¢Ó°¢Ğ ¢–b€¢DÔ”åõ$Ud”UuôÔôDP¢’°¢6öç7BFG&W72Ğ¢6fVDFG&W74'”–B€¢6†—–ætFG&W74–@¢“° ¢6öç7B–ÖVçBĞ¢6fVE–ÖVçD'”–B€¢–ÖVçDÖWF†öD–@¢“° ¢6öç7B&öf–ÆU&V6÷&BÒ°¢6Æ÷BÀ¢&öf–ÆTæÖRÀ¢Æö6¶VC ¢fÇ6RÀ¢&WF–ÆW'3 ¢ö&¦V7Bæg&öÔVçG&–W2€¢$UD”ÄU%2æÖ€¢&WF–ÆW"Óâ°¢&WF–ÆW"æ¶W’À¢°¢W6W&æÖS ¢&WF–ÆW'5°¢&WF–ÆW"æ¶W¢ÓòçW6W&æÖRÇÀ¢""À¢77v÷&D6öæf–wW&VC ¢&ööÆVâ€¢&WF–ÆW'5°¢&WF–ÆW"æ¶W¢Óòç77v÷&@¢¢Ğ¢Ğ¢¢’À¢7W7FöÖW%&öf–ÆS¢°¢ââæ7W7FöÖW%&öf–ÆRÀ ¢f—'7DæÖS ¢7W7FöÖW%&öf–ÆRæf—'7DæÖRÇÀ¢FG&W73òæf—'7DæÖRÇÀ¢""À ¢Æ7DæÖS ¢7W7FöÖW%&öf–ÆRæÆ7DæÖRÇÀ¢FG&W73òæÆ7DæÖRÇÀ¢""À ¢VÖ–Ã ¢7W7FöÖW%&öf–ÆRæVÖ–ÂÇÀ¢7FFRæ7W7FöÖW#òæVÖ–ÂÇÀ¢""À ¢FG&W73 ¢7W7FöÖW%&öf–ÆRæFG&W72ÇÀ¢FG&W73òæFG&W72ÇÀ¢""À ¢FG&W73# ¢7W7FöÖW%&öf–ÆRæFG&W73"ÇÀ¢FG&W73òæFG&W73"ÇÀ¢""À ¢6—G“ ¢7W7FöÖW%&öf–ÆRæ6—G’ÇÀ¢FG&W73òæ6—G’ÇÀ¢""À ¢7FFS ¢7W7FöÖW%&öf–ÆRç7FFRÇÀ¢FG&W73òç7FFRÇÀ¢""À ¢¦— ¢7W7FöÖW%&öf–ÆRç¦—ÇÀ¢FG&W73òç¦—ÇÀ¢""À ¢6÷VçG'“ ¢7W7FöÖW%&öf–ÆRæ6÷VçG'’ÇÀ¢FG&W73òæ6÷VçG'’ÇÀ¢%U2 ¢ÒÀ ¢7W7FöÖW$6&C¢°¢6&DÆ&VÃ ¢7W7FöÖW$6&Bæ6&DÆ&VÂÇÀ¢–ÖVçCòæ6&DÆ&VÂÇÀ¢""À ¢6&F†öÆFW# ¢7W7FöÖW$6&Bæ6&F†öÆFW"ÇÀ¢–ÖVçCòæ6&F†öÆFW"ÇÀ¢""À ¢Ö6¶VDçVÖ&W# ¢7W7FöÖW$6&Bæ6ô6&DçVÖ&W ¢ò(
.(
.(
.(
"(
.(
.(
.(
"(
.(
.(
.(
"G¶7W7FöÖW$6&Bæ6ô6&DçVÖ&W"ç&WÆ6R‚õÄBörÂ""’ç6Æ–6R‚ÓB—Ö ¢¢€¢–ÖVçCòæÖ6¶VDçVÖ&W"ÇÀ¢" ¢’À ¢W‡ÖöçFƒ ¢7W7FöÖW$6&BæW‡ÖöçF‚ÇÀ¢–ÖVçCòæW‡ÖöçF‚ÇÀ¢""À ¢W‡–V# ¢7W7FöÖW$6&BæW‡–V"ÇÀ¢–ÖVçCòæW‡–V"ÇÀ¢" ¢ÒÀ ¢6VÆV7FVDFG&W74–C ¢6†—–ætFG&W74–BÇÀ¢çVÆÂÀ¢6VÆV7FVE–ÖVçD–C ¢–ÖVçDÖWF†öD–BÇÀ¢çVÆÀ¢Ó° ¢&öf–ÆU&V6÷&Bç&VF–æW72Ğ¢&öf–ÆU&VF–æW72€¢&öf–ÆU&V6÷&Bæ7W7FöÖW%&öf–ÆRÀ¢&öf–ÆU&V6÷&Bæ7W7FöÖW$6&@¢“° ¢&öf–ÆU&V6÷&Bæ7F—fF–öå7FGW2Ğ¢&öf–ÆU&V6÷&Bç&VF–æW72ç&VG¢ò&v—F–æuö7F—fF–öâ ¢¢&–æ6ö×ÆWFR#° ¢G'’°¢6öç7B7–æ5&W7öç6RĞ¢v—BfWF6‚€¢"ö’öFÖ–â÷FW7B×&öf–ÆR×v÷&¶fÆ÷r"À¢°¢ÖWF†öC¢%UB"À¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ¢&öG“ ¢¥4ôâç7G&–æv–g’‡°¢6Æ÷BÀ¢&öf–ÆTæÖRÀ¢7W7FöÖW%&öf–ÆS ¢&öf–ÆU&V6÷&Bæ7W7FöÖW%&öf–ÆRÀ¢7W7FöÖW$6&C¢°¢6&DÆ&VÃ ¢7W7FöÖW$6&Bæ6&DÆ&VÂÇÀ¢–ÖVçCòæ6&DÆ&VÂÇÀ¢""À¢6&F†öÆFW# ¢7W7FöÖW$6&Bæ6&F†öÆFW"ÇÀ¢–ÖVçCòæ6&F†öÆFW"ÇÀ¢""À¢6ô6&DçVÖ&W# ¢7W7FöÖW$6&Bæ6ô6&DçVÖ&W"ÇÀ¢–ÖVçCòçFW7D6&DçVÖ&W"ÇÀ¢€¢–ÖVç@¢ò#C ¢¢" ¢’À¢W‡ÖöçFƒ ¢7W7FöÖW$6&BæW‡ÖöçF‚ÇÀ¢–ÖVçCòæW‡ÖöçF‚ÇÀ¢""À¢W‡–V# ¢7W7FöÖW$6&BæW‡–V"ÇÀ¢–ÖVçCòæW‡–V"ÇÀ¢""À¢6V7W&—G”6öFS ¢7W7FöÖW$6&Bç6V7W&—G”6öFRÇÀ¢€¢–ÖVç@¢ò##3B ¢¢" ¢¢ÒÀ¢&WF–ÆW'0¢Ò¢Ğ¢“° ¢6öç7B7–æ6VBĞ¢v—B&VD§6öâ€¢7–æ5&W7öç6P¢“° ¢–b€¢7–æ5&W7öç6Ræö²b`¢7–æ6VBç&öf–ÆP¢’°¢ö&¦V7Bæ76–vâ€¢&öf–ÆU&V6÷&BÀ¢7–æ6VBç&öf–ÆP¢“°¢Ğ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$FÖ–âFW7B7W7FöÖW"7F—fF–öâ7–æ2f–ÆVC¢"À¢W'&÷ ¢“°¢Ğ ¢6öç7BW†—7F–ærĞ¢7FFRç&WF–ÆW%&öf–ÆW0¢æf–æD–æFW‚€¢—FVÒÓà¢çVÖ&W"€¢—FVÒç6Æ÷@¢’ÓÓÒ6Æ÷@¢“° ¢–b†W†—7F–ærãÒ’°¢7FFRç&WF–ÆW%&öf–ÆW5°¢W†—7F–æp¢ÒÒ&öf–ÆU&V6÷&C°¢ÒVÇ6R°¢7FFRç&WF–ÆW%&öf–ÆW2çW6‚€¢&öf–ÆU&V6÷&@¢“°¢Ğ ¢6öç7B–Dw&÷W÷VâĞ¢–E&öf–ÆW4w&÷W—4÷Vâ‚“° ¢&VæFW%&WF–ÆW%&öf–ÆW2‚“° ¢&W7F÷&U–E&öf–ÆW4w&÷W÷Vâ€¢–Dw&÷W÷Và¢“° ¢&V÷Vå–E&öf–ÆR€¢6Æ÷@¢“° ¢6†÷t66÷VçDÖW76vR€¢FW7B&öf–ÆRG·6Æ÷GÒ6fVBæÀ¢'7V66W72 ¢“° ¢&WGW&ã°¢Ğ ¢G'’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢G'VRÀ¢%6f–æ~(
b ¢“° ¢6WDÖW76vR€¢ÖW76vRÀ¢" ¢“° ¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢ö’ö66÷VçB÷&WF–ÆW"×&öf–ÆW2òG·6Æ÷GÖÀ¢°¢ÖWF†öC¢%UB"À ¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ ¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À ¢&öG“ ¢¥4ôâç7G&–æv–g’‡°¢&öf–ÆTæÖRÀ¢&WF–ÆW'2À¢6†—–ætFG&W74–BÀ¢–ÖVçDÖWF†öD–BÀ¢7W7FöÖW%&öf–ÆRÀ¢7W7FöÖW$6&@¢Ò¢Ğ¢“° ¢6öç7BFFĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢FFæW'&÷"ÇÀ¢%Væ&ÆRFò6fRF†—2&öf–ÆRâ ¢“°¢Ğ ¢6öç7B6fVE&öf–ÆRĞ¢FFç&öf–ÆRÇÂçVÆÃ° ¢–b‡6fVE&öf–ÆR’°¢6öç7BW†•¶¬{®0®+^zºè¬è‘ééŠ—³tingIndex =
        state.retailerProfiles
          .findIndex(
            profile =>
              Number(
                profile.slot
              ) === slot
          );

      if (
        existingIndex >= 0
      ) {
        state.retailerProfiles[
          existingIndex
        ] = savedProfile;
      } else {
        state.retailerProfiles.push(
          savedProfile
        );
      }
    }

    state.retailerAllowance =
      Math.max(
        0,
        Number(
          data.allowance ??
          state.retailerAllowance
        ) || 0
      );

    /*
      Render again so newly stored passwords
      immediately change to "Password saved".
      The password itself is never returned
      from the server.
    */

    const paidGroupOpen =
      paidProfilesGroupIsOpen();

    renderRetailerProfiles();

    restorePaidProfilesGroupOpen(
      paidGroupOpen
    );

    reopenPaidProfile(
      slot
    );

    const refreshedMessage =
      document.querySelector(
        `[data-retailer-profile-message="${slot}"]`
      );

    setMessage(
      refreshedMessage,
      data.message ||
      `Profile ${slot} saved securely.`,
      "success"
    );

    await loadCustomerNotifications({
      showPopup:
        false
    });

  } catch (error) {
    setMessage(
      message,
      error.message,
      "error"
    );

  } finally {
    setButtonBusy(
      button,
      false
    );
  }
}

async function saveSpecialProfile(
  event
) {
  event.preventDefault();

  const form =
    event.currentTarget;

  const profileType =
    String(
      form.dataset
        .specialProfileForm ||
      ""
    )
      .trim()
      .toLowerCase();

  const message =
    document.querySelector(
      `[data-special-profile-message="${CSS.escape(
        profileType
      )}"]`
    );

  const button =
    form.querySelector(
      'button[type="submit"]'
    );

  if (
    ![
      "free",
      "rented"
    ].includes(
      profileType
    )
  ) {
    setMessage(
      message,
      "Invalid special profile.",
      "error"
    );

    return;
  }

  const formData =
    new FormData(form);

  const retailers = {};

  for (
    const retailer of
    RETAILERS
  ) {
    retailers[
      retailer.key
    ] = {
      username:
        String(
          formData.get(
            `${retailer.key}Username`
          ) || ""
        ).trim(),

      password:
        String(
          formData.get(
            `${retailer.key}Password`
          ) || ""
        )
    };
  }

  try {
    setButtonBusy(
      button,
      true,
      "Savingâ€¦"
    );

    setMessage(
      message,
      ""
    );

    const response =
      await fetch(
        `/api/account/special-profiles/${encodeURIComponent(
          profileType
        )}`,
        {
          method: "PUT",

          headers: {
            "Content-Type":
              "application/json"
          },

          credentials:
            "same-origin",

          body:
            JSON.stringify({
              retailers
            })
        }
      );

    const data =
      await readJson(
        response
      );

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Unable to save this special profile."
      );
    }

    const savedProfile =
      data.profile || null;

    if (savedProfile) {
      const existingIndex =
        state.specialProfiles
          .findIndex(
            profile =>
              profile.profileType ===
              profileType
          );

      if (
        existingIndex >= 0
      ) {
        state.specialProfiles[
          existingIndex
        ] = savedProfile;

      } else {
        state.specialProfiles.push(
          savedProfile
        );
      }
    }

    renderRetailerProfiles();

    const refreshedMessage =
      document.querySelector(
        `[data-special-profile-message="${CSS.escape(
          profileType
        )}"]`
      );

    setMessage(
      refreshedMessage,
      data.message ||
      `${
        profileType === "rented"
          ? "RENTED PROFILE"
          : "FREE PROFILE"
      } saved securely.`,
      "success"
    );

  } catch (error) {
    setMessage(
      message,
      error.message,
      "error"
    );

  } finally {
    setButtonBusy(
      button,
      false
    );
  }
}

/* =====================================================
   SUCCESS DASHBOARD
===================================================== */

const successState = {
  loaded: false,
  loading: false,
  data: null,

  rangeStart: null,
  rangeEnd: null
};


function successDateInputValue(
  date
) {
  return date
    .toISOString()
    .slice(0, 10);
}


function getDefaultSuccessRange() {
  const end =
    new Date();

  end.setHours(
    12,
    0,
    0,
    0
  );

  const start =
    new Date(end);

  start.setDate(
    end.getDate() - 13
  );

  return {
    start:
      successDateInputValue(
        start
      ),

    end:
      successDateInputValue(
        end
      )
  };
}


function getSuccessRange() {
  if (
    successState.rangeStart &&
    successState.rangeEnd
  ) {
    return {
      start:
        successState.rangeStart,

      end:
        successState.rangeEnd
    };
  }

  const range =
    getDefaultSuccessRange();

  successState.rangeStart =
    range.start;

  successState.rangeEnd =
    range.end;

  return range;
}


function successRangeDays(
  start,
  end
) {
  const startDate =
    new Date(
      `${start}T12:00:00`
    );

  const endDate =
    new Date(
      `${end}T12:00:00`
    );

  return (
    Math.round(
      (
        endDate.getTime() -
        startDate.getTime()
      ) /
      (
        1000 *
        60 *
        60 *
        24
      )
    ) + 1
  );
}


function shiftSuccessRange(
  direction
) {
  const range =
    getSuccessRange();

  const days =
    successRangeDays(
      range.start,
      range.end
    );

  const start =
    new Date(
      `${range.start}T12:00:00`
    );

  const end =
    new Date(
      `${range.end}T12:00:00`
    );

  start.setDate(
    start.getDate() +
    (
      direction *
      days
    )
  );

  end.setDate(
    end.getDate() +
    (
      direction *
      days
    )
  );

  const today =
    new Date();

  today.setHours(
    12,
    0,
    0,
    0
  );

  if (
    end.getTime() >
    today.getTime()
  ) {
    end.setTime(
      today.getTime()
    );

    start.setTime(
      today.getTime()
    );

    start.setDate(
      start.getDate() -
      (
        days - 1
      )
    );
  }

  successState.rangeStart =
    successDateInputValue(
      start
    );

  successState.rangeEnd =
    successDateInputValue(
      end
    );
}


function formatSuccessRangeLabel(
  start,
  end
) {
  const startDate =
    new Date(
      `${start}T12:00:00`
    );

  const endDate =
    new Date(
      `${end}T12:00:00`
    );

  const startText =
    startDate.toLocaleDateString(
      "en-US",
      {
        month: "short",
        day: "numeric",
        year: "numeric"
      }
    );

  const endText =
    endDate.toLocaleDateString(
      "en-US",
      {
        month: "short",
        day: "numeric",
        year: "numeric"
      }
    );

  return `${startText} â€“ ${endText}`;
}


function formatSuccessCurrency(
  value
) {
  const amount =
    Number(value);

  if (!Number.isFinite(amount)) {
    return "$0.00";
  }

  return new Intl.NumberFormat(
    "en-US",
    {
      style: "currency",
      currency: "USD"
    }
  ).format(amount);
}


function formatSuccessNumber(
  value
) {
  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return "0";
  }

  return new Intl.NumberFormat(
    "en-US"
  ).format(number);
}


function formatSuccessDate(
  value
) {
  if (!value) {
    return "â€”";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return String(value);
  }

  return date.toLocaleDateString(
    undefined,
    {
      month: "short",
      day: "numeric",
      year: "numeric"
    }
  );
}


function setSuccessText(
  id,
  value
) {
  const element =
    document.getElementById(id);

  if (!element) {
    return;
  }

  element.textContent =
    value ?? "â€”";
}


function renderSuccessChart(
  activity = []
) {
  const chart =
    document.getElementById(
      "success-chart"
    );

  if (!chart) {
    return;
  }

  const range =
    getSuccessRange();

  const today =
    successDateInputValue(
      new Date()
    );

  const normalizedActivity =
    Array.isArray(activity)
      ? activity.map(item => {
          const count =
            Math.max(
              0,
              Number(
                item.count ??
                item.checkouts ??
                0
              ) || 0
            );

          const value =
            Math.max(
              0,
              Number(
                item.value ??
                item.checkoutValue ??
                item.total ??
                0
              ) || 0
            );

          const rawDate =
            item.date ||
            item.label ||
            "";

          const parsedDate =
            rawDate
              ? new Date(
                  `${rawDate}T12:00:00`
                )
              : null;

          const label =
            parsedDate &&
            !Number.isNaN(
              parsedDate.getTime()
            )
              ? parsedDate
                  .toLocaleDateString(
                    "en-US",
                    {
                      month: "short",
                      day: "numeric"
                    }
                  )
              : rawDate;

          return {
            count,
            value,
            rawDate,
            label
          };
        })
      : [];

  const maximum =
    Math.max(
      0,
      ...normalizedActivity.map(
        item => item.count
      )
    );


  /*
    Choose a clean automatic Y-axis
    interval based on the customer's
    busiest day in the selected range.
  */
  function niceStep(
    maxValue
  ) {
    if (maxValue <= 2) {
      return 1;
    }

    const roughStep =
      maxValue / 5;

    const magnitude =
      Math.pow(
        10,
        Math.floor(
          Math.log10(
            roughStep
          )
        )
      );

    const normalized =
      roughStep /
      magnitude;

    let multiplier;

    if (normalized <= 1) {
      multiplier = 1;
    } else if (
      normalized <= 2
    ) {
      multiplier = 2;
    } else if (
      normalized <= 2.5
    ) {
      multiplier = 2.5;
    } else if (
      normalized <= 5
    ) {
      multiplier = 5;
    } else {
      multiplier = 10;
    }

    return (
      multiplier *
      magnitude
    );
  }


  const step =
    niceStep(
      Math.max(
        1,
        maximum
      )
    );

  let axisMaximum =
    Math.ceil(
      Math.max(
        1,
        maximum
      ) /
      step
    ) *
    step;

  /*
    A single checkout should not fill
    the entire graph.
  */
  if (
    maximum <= 1
  ) {
    axisMaximum = 2;
  }

  const axisTicks = [];

  for (
    let tick = 0;
    tick <= axisMaximum +
      step / 2;
    tick += step
  ) {
    axisTicks.push(
      Number(
        tick.toFixed(4)
      )
    );
  }

  const columnsHtml =
    normalizedActivity
      .map(item => {
        const height =
          item.count > 0
            ? (
                item.count /
                axisMaximum
              ) * 100
            : 0;

        return `
          <div
            class="success-chart-column"
            title="${escapeHtml(
              `${item.label}: ${
                item.count
              } checkout${
                item.count === 1
                  ? ""
                  : "s"
              } â€” ${formatSuccessCurrency(
                item.value
              )}`
            )}"
          >

            <div
              class="success-chart-bar-wrap"
            >

              ${
                item.count > 0
                  ? `
                    <div
                      class="success-chart-value"
                    >
                      ${escapeHtml(
                        formatSuccessCurrency(
                          item.value
                        )
                      )}
                    </div>
                  `
                  : ""
              }

              <div
                class="success-chart-bar"
                style="height: ${height}%"
              ></div>

            </div>

            <span>
              ${escapeHtml(
                item.label
              )}
            </span>

          </div>
        `;
      })
      .join("");


  const ticksHtml =
    [...axisTicks]
      .reverse()
      .map(tick => `
        <div
          class="success-chart-y-tick"
        >
          <span>
            ${escapeHtml(
              formatSuccessNumber(
                tick
              )
            )}
          </span>

          <i></i>
        </div>
      `)
      .join("");


  const nextDisabled =
    range.end >= today;


  chart.innerHTML = `
    <div class="success-chart-controls">

      <button
        type="button"
        class="success-range-button"
        id="success-range-previous"
      >
        â† Previous
      </button>

      <button
        type="button"
        class="success-range-current"
        id="success-range-current"
      >
        ${escapeHtml(
          formatSuccessRangeLabel(
            range.start,
            range.end
          )
        )}
      </button>

      <button
        type="button"
        class="success-range-button"
        id="success-range-next"
        ${
          nextDisabled
            ? "disabled"
            : ""
        }
      >
        Next â†’
      </button>

      <button
        type="button"
        class="success-range-button success-range-choose"
        id="success-range-choose"
      >
        Choose Dates
      </button>

    </div>


    <div
      class="success-date-picker"
      id="success-date-picker"
      hidden
    >

      <label>
        <span>Start Date</span>

        <input
          type="date"
          id="success-range-start"
          value="${escapeHtml(
            range.start
          )}"
          max="${escapeHtml(
            today
          )}"
        />
      </label>

      <label>
        <span>End Date</span>

        <input
          type="date"
          id="success-range-end"
          value="${escapeHtml(
            range.end
          )}"
          max="${escapeHtml(
            today
          )}"
        />
      </label>

      <button
        type="button"
        class="primary"
        id="success-range-apply"
      >
        Apply
      </button>

      <button
        type="button"
        class="success-range-button"
        id="success-range-cancel"
      >
        Cancel
      </button>

    </div>


    ${
      normalizedActivity.length
        ? `
          <div class="success-chart-layout">

            <div class="success-chart-y-axis">

              <div class="success-chart-y-title">
                CHECKOUTS
              </div>

              <div class="success-chart-y-ticks">
                ${ticksHtml}
              </div>

            </div>


            <div class="success-chart-plot">

              <div class="success-chart-grid">
                ${[...axisTicks]
                  .reverse()
                  .map(
                    () => `
                      <div
                        class="success-chart-grid-line"
                      ></div>
                    `
                  )
                  .join("")}
              </div>

              <div class="success-chart-columns">
                ${columnsHtml}
              </div>

            </div>

          </div>
        `
        : `
          <div class="success-chart-empty">
            Checkout activity will appear
            here after successful checkouts
            are synchronized.
          </div>
        `
    }
  `;


  document
    .getElementById(
      "success-range-previous"
    )
    ?.addEventListener(
      "click",
      async () => {
        shiftSuccessRange(-1);

        successState.loaded =
          false;

        await loadSuccessDashboard(
          true
        );
      }
    );


  document
    .getElementById(
      "success-range-next"
    )
    ?.addEventListener(
      "click",
      async () => {
        shiftSuccessRange(1);

        successState.loaded =
          false;

        await loadSuccessDashboard(
          true
        );
      }
    );


  const datePicker =
    document.getElementById(
      "success-date-picker"
    );


  document
    .getElementById(
      "success-range-choose"
    )
    ?.addEventListener(
      "click",
      () => {
        if (datePicker) {
          datePicker.hidden =
            !datePicker.hidden;
        }
      }
    );


  document
    .getElementById(
      "success-range-current"
    )
    ?.addEventListener(
      "click",
      () => {
        if (datePicker) {
          datePicker.hidden =
            !datePicker.hidden;
        }
      }
    );


  document
    .getElementById(
      "success-range-cancel"
    )
    ?.addEventListener(
      "click",
      () => {
        if (datePicker) {
          datePicker.hidden = true;
        }
      }
    );


  document
    .getElementById(
      "success-range-apply"
    )
    ?.addEventListener(
      "click",
      async () => {
        const startInput =
          document.getElementById(
            "success-range-start"
          );

        const endInput =
          document.getElementById(
            "success-range-end"
          );

        const start =
          startInput?.value || "";

        const end =
          endInput?.value || "";

        if (
          !start ||
          !end
        ) {
          alert(
            "Choose both a start and end date."
          );

          return;
        }

        if (
          start > end
        ) {
          alert(
            "The start date must be before the end date."
          );

          return;
        }

        if (
          end > today
        ) {
          alert(
            "The end date cannot be in the future."
          );

          return;
        }

        const days =
          successRangeDays(
            start,
            end
          );

        if (
          days < 1 ||
          days > 180
        ) {
          alert(
            "Choose a date range of 180 days or less."
          );

          return;
        }

        successState.rangeStart =
          start;

        [jÇºã
âµç«®ŠÁ®‰˜©{7V66W757FFRç&ævTVæBĞ¢VæC° ¢7V66W757FFRæÆöFVBĞ¢fÇ6S° ¢v—BÆöE7V66W74F6†&ö&B€¢G'VP¢“°¢Ğ¢“°§Ğ  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢5T44U52(	B$T4TåBõ$DU"4$õU4TÀ£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦ÆWB7V66W746†V6¶÷WD–æFW‚Ò°  ¦gVæ7F–öâvWE7V66W746†V6¶÷WD—FV×2€¢6†V6¶÷W@¢’°¢–b€¢'&’æ—4'&’†6†V6¶÷WCòæ—FV×2’b`¢6†V6¶÷WBæ—FV×2æÆVæwF€¢’°¢&WGW&â6†V6¶÷WBæ—FV×3°¢Ğ ¢6öç7B&öGV7DæÖRĞ¢6†V6¶÷WCòç&öGV7BÇÀ¢6†V6¶÷WCòç&öGV7DæÖRÇÀ¢6†V6¶÷WCòæ—FVÒÇÀ¢"#° ¢–b‚&öGV7DæÖR’°¢&WGW&âµÓ°¢Ğ ¢&WGW&â°¢°¢æÖS¢&öGV7DæÖRÀ ¢VçF—G“ ¢ÖF‚æÖ‚€¢À¢çVÖ&W"€¢6†V6¶÷WBçVçF—G’óğ¢6†V6¶÷WBæ—FVÔ6÷VçBóğ¢¢’ÇÂ¢’À ¢&–6S ¢çVÖ&W"€¢6†V6¶÷WBç&–6Róğ¢6†V6¶÷WBæ—FVÕ&–6Róğ¢ ¢’ÇÂÀ ¢–ÖvUW&Ã ¢6†V6¶÷WBæ–ÖvUW&ÂÇÀ¢6†V6¶÷WBç&öGV7D–ÖvRÇÀ¢çVÆÀ¢Ğ¢Ó°§Ğ  ¦gVæ7F–öâvWE7V66W74—FVÔ–ÖvR€¢—FVĞ¢’°¢&WGW&â€¢—FVÓòæ–ÖvUW&ÂÇÀ¢—FVÓòæ–ÖvRÇÀ¢—FVÓòç&öGV7D–ÖvRÇÀ¢—FVÓòçF‡VÖ&æ–ÂÇÀ¢" ¢“°§Ğ  ¦gVæ7F–öâ&VæFW%7V66W75&öGV7E&Wf–Wr€¢—FVÒÀ¢–æFW€¢’°¢6öç7BæÖRĞ¢—FVÓòææÖRÇÀ¢—FVÓòç&öGV7DæÖRÇÀ¢—FVÒG¶–æFW‚²Ö° ¢6öç7B–ÖvRĞ¢vWE7V66W74—FVÔ–ÖvR€¢—FVĞ¢“° ¢6öç7BVçF—G’Ğ¢ÖF‚æÖ‚€¢À¢çVÖ&W"€¢—FVÓòçVçF—G’óğ¢—FVÓòçG’óğ¢¢’ÇÂ¢“° ¢–b†–ÖvR’°¢&WGW&â ¢ÆF—`¢6Æ73Ò'7V66W72×&öGV7B×&Wf–Wr ¢F—FÆSÒ"G¶W66T‡FÖÂ†æÖR—Ò ¢à¢ÆF—b6Æ73Ò'7V66W72×&öGV7BÖ–ÖvR×w&#à ¢Æ–Öp¢7&3Ò"G¶W66T‡FÖÂ†–ÖvR—Ò ¢ÇCÒ"G¶W66T‡FÖÂ†æÖR—Ò ¢6Æ73Ò'7V66W72×&öGV7BÖ–ÖvR ¢ÆöF–æsÒ&Æ§’ ¢&VfW'&W'öÆ–7“Ò&æò×&VfW'&W" ¢óà ¢G°¢VçF—G’â¢ò ¢Ç7à¢6Æ73Ò'7V66W72×&öGV7B×VçF—G’ ¢à¢9rG¶f÷&ÖE7V66W74çVÖ&W"€¢VçF—G¢—Ğ¢Â÷7ãà¢ ¢¢" ¢Ğ ¢ÂöF—cà ¢Ç7â6Æ73Ò'7V66W72×&öGV7B×&Wf–WrÖæÖR#à¢G¶W66T‡FÖÂ†æÖR—Ğ¢Â÷7ãà¢ÂöF—cà¢°¢Ğ ¢&WGW&â ¢ÆF—`¢6Æ73Ò'7V66W72×&öGV7B×&Wf–Wr ¢F—FÆSÒ"G¶W66T‡FÖÂ†æÖR—Ò ¢à¢ÆF—`¢6Æ73Ò'7V66W72×&öGV7BÖ–ÖvR×w&7V66W72×&öGV7B×Æ6V†öÆFW" ¢à¢Ç7ãà¢•DTĞ¢Â÷7ãà ¢G°¢VçF—G’â¢ò ¢Ç7à¢6Æ73Ò'7V66W72×&öGV7B×VçF—G’ ¢à¢9rG¶f÷&ÖE7V66W74çVÖ&W"€¢VçF—G¢—Ğ¢Â÷7ãà¢ ¢¢" ¢Ğ¢ÂöF—cà ¢Ç7â6Æ73Ò'7V66W72×&öGV7B×&Wf–WrÖæÖR#à¢G¶W66T‡FÖÂ†æÖR—Ğ¢Â÷7ãà¢ÂöF—cà¢°§Ğ  ¦gVæ7F–öâ&VæFW%7V66W746†V6¶÷WG2€¢6†V6¶÷WG2ÒµĞ¢’°¢6öç7B6öçF–æW"Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'7V66W72Ö6†V6¶÷WG2 ¢“° ¢–b‚6öçF–æW"’°¢&WGW&ã°¢Ğ ¢–b€¢'&’æ—4'&’†6†V6¶÷WG2’ÇÀ¢6†V6¶÷WG2æÆVæwF‚ÓÓÒ ¢’°¢7V66W746†V6¶÷WD–æFW‚Ò° ¢6öçF–æW"æ–ææW$…DÔÂÒ ¢ÆF—b6Æ73Ò'7V66W72ÖV×G’#à ¢Ç7G&öæsà¢æò7V66W76gVÂ6†V6¶÷WG2–WBà¢Â÷7G&öæsà ¢Çà¢7V66W76gVÂ4ò6†V6¶÷WG2v–ÆÀ¢V"†W&RgFW"F†W’&P¢7–æ6‡&öæ—¦VBFò–÷W"66÷VçBà¢Â÷à ¢ÂöF—cà¢° ¢&WGW&ã°¢Ğ  ¢ò ¢¶VWF†R6VÆV7FVB÷&FW"–ç6–FRF†P¢f–Æ&ÆR6†V6¶÷WB&ævRà¢¢ğ¢7V66W746†V6¶÷WD–æFW‚Ğ¢ÖF‚æÖ–â€¢ÖF‚æÖ‚€¢7V66W746†V6¶÷WD–æFW‚À¢ ¢’À¢6†V6¶÷WG2æÆVæwF‚Ò¢“°  ¢6öç7B6†V6¶÷WBĞ¢6†V6¶÷WG5°¢7V66W746†V6¶÷WD–æFW€¢Ó°  ¢6öç7B&WF–ÆW"Ğ¢6†V6¶÷WBç&WF–ÆW"ÇÀ¢6†V6¶÷WBç7F÷&RÇÀ¢%&WF–ÆW"#°  ¢6öç7B÷&FW$çVÖ&W"Ğ¢6†V6¶÷WBæ÷&FW$çVÖ&W"ÇÀ¢6†V6¶÷WBæ÷&FW$–BÇÀ¢6†V6¶÷WBæ–BÇÀ¢"#°  ¢6öç7BFFRĞ¢6†V6¶÷WBæ6†V6¶÷WDBÇÀ¢6†V6¶÷WBæFFRÇÀ¢6†V6¶÷WBæ7&VFVDBÇÀ¢çVÆÃ°  ¢ò ¢”Õõ%DåC ¢÷W"æ÷&ÖÆ—¦VB7V66W72&V6÷&G2W6P¢—FVÔ6÷VçBæB÷&FW%F÷FÂà ¢öÆFW"fÆÆ&6²æÖW2&VÖ–â7W÷'FV@¢6ò†—7F÷&–6Â÷FW7BFF7F–ÆÂv÷&·2à¢¢ğ¢6öç7BVçF—G’Ğ¢ÖF‚æÖ‚€¢À¢çVÖ&W"€¢6†V6¶÷WBæ—FVÔ6÷VçBóğ¢6†V6¶÷WBçVçF—G’óğ¢6†V6¶÷WBçF÷FÄ—FV×2óğ¢ ¢’ÇÂ ¢“°  ¢6öç7BfÇVRĞ¢çVÖ&W"€¢6†V6¶÷WBæ÷&FW%F÷FÂóğ¢6†V6¶÷WBæ6†V6¶÷WEfÇVRóğ¢6†V6¶÷WBçfÇVRóğ¢6†V6¶÷WBçF÷FÂóğ¢6†V6¶÷WBæÖ÷VçBóğ¢ ¢’ÇÂ°  ¢6öç7B—FV×2Ğ¢vWE7V66W746†V6¶÷WD—FV×2€¢6†V6¶÷W@¢“°  ¢ò ¢&V6VçB7V66W72–çFVçF–öæÆÇ’6†÷w0¢æòÖ÷&RF†âF‡&VR&öGV7G2à¢¢ğ¢6öç7B&Wf–Wt—FV×2Ğ¢—FV×2ç6Æ–6R€¢À¢0¢“°  ¢6öç7B†–FFVå&öGV7G2Ğ¢ÖF‚æÖ‚€¢À¢—FV×2æÆVæwF‚Ğ¢&Wf–Wt—FV×2æÆVæwF€¢“°  ¢6öç7B&öGV7E&Wf–Wt‡FÖÂĞ¢&Wf–Wt—FV×2æÆVæwF€¢ò&Wf–Wt—FV×0¢æÖ€¢€¢—FVÒÀ¢–æFW€¢’Óà¢&VæFW%7V66W75&öGV7E&Wf–Wr€¢—FVÒÀ¢–æFW€¢¢¢æ¦ö–â‚""¢¢ ¢ÆF—`¢6Æ73Ò'7V66W72×&öGV7B×&Wf–Wr ¢à¢ÆF—`¢6Æ73Ò'7V66W72×&öGV7BÖ–ÖvR×w&7V66W72×&öGV7B×Æ6V†öÆFW" ¢à¢Ç7ãà¢•DTĞ¢Â÷7ãà¢ÂöF—cà ¢Ç7à¢6Æ73Ò'7V66W72×&öGV7B×&Wf–WrÖæÖR ¢à¢7V66W76gVÂ6†V6¶÷W@¢Â÷7ãà¢ÂöF—cà¢°  ¢6öçF–æW"æ–ææW$…DÔÂÒ ¢ÆF—b6Æ73Ò'7V66W72×&V6VçB×6†VÆÂ#à ¢ÆF—b6Æ73Ò'7V66W72×&V6VçB×F÷#à ¢ÆF—cà¢Ç7â6Æ73Ò'7V66W72Ö6†V6¶÷WB×&WF–ÆW"#à¢G¶W66T‡FÖÂ‡&WF–ÆW"—Ğ¢Â÷7ãà ¢ÆƒCà¢7V66W76gVÂ6†V6¶÷W@¢ÂöƒCà ¢Çà¢G¶W66T‡FÖÂ€¢f÷&ÖE7V66W74FFR€¢FFP¢¢—Ğ¢Â÷à¢ÂöF—cà  ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2ÖÆ–æ² ¢–CÒ'7V66W72ÖÆÂÖ÷&FW'2 ¢à¢ÄÂõ$DU%2(i ¢Âö'WGFöãà ¢ÂöF—cà  ¢ÆF—b6Æ73Ò'7V66W72×&öGV7B×&Wf–Ww2#à ¢G·&öGV7E&Wf–Wt‡FÖÇĞ ¢ÂöF—cà  ¢G°¢†–FFVå&öGV7G2â ¢ò ¢ÆF—`¢6Æ73Ò'7V66W72ÖÖ÷&R×&öGV7G2 ¢à¢²G¶f÷&ÖE7V66W74çVÖ&W"€¢†–FFVå&öGV7G0¢—Ğ¢Ö÷&RG°¢†–FFVå&öGV7G2ÓÓÒ¢ò'&öGV7B ¢¢'&öGV7G2 ¢Ğ¢ÂöF—cà¢ ¢¢" ¢Ğ  ¢ÆF—b6Æ73Ò'7V66W72Ö6†V6¶÷WB×7VÖÖ'’#à ¢ÆF—cà¢Ç7ãà¢•DTÕ24T5U$T@¢Â÷7ãà ¢Ç7G&öæsà¢G¶f÷&ÖE7V66W74çVÖ&W"€¢VçF—G¢—Ğ¢Â÷7G&öæsà¢ÂöF—cà  ¢ÆF—cà¢Ç7ãà¢4„T4´õUBdÅTP¢Â÷7ãà ¢Ç7G&öæsà¢G¶W66T‡FÖÂ€¢f÷&ÖE7V66W747W'&Væ7’€¢fÇVP¢¢—Ğ¢Â÷7G&öæsà¢ÂöF—cà  ¢G°¢÷&FW$çVÖ&W ¢ò ¢ÆF—cà¢Ç7ãà¢õ$DU ¢Â÷7ãà ¢Ç7G&öæsà¢G¶W66T‡FÖÂ€¢÷&FW$çVÖ&W ¢—Ğ¢Â÷7G&öæsà¢ÂöF—cà¢ ¢¢" ¢Ğ ¢ÂöF—cà  ¢ÆF—b6Æ73Ò'7V66W72Ö÷&FW"Öæf–vF–öâ#à ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'7V66W72Ö÷&FW"ÖæbÖ'WGFöâ ¢–CÒ'7V66W72Ö÷&FW"×&Wf–÷W2 ¢G°¢7V66W746†V6¶÷WD–æFW‚ÓÓÒ ¢ò&F—6&ÆVB ¢¢" ¢Ğ¢à¢(i&Wf–÷W2÷&FW ¢Âö'WGFöãà  ¢Ç7â6Æ73Ò'7V66W72Ö÷&FW"×÷6—F–öâ#à¢G¶f÷&ÖE7V66W74çVÖ&W"€¢7V66W746†V6¶÷WD–æFW‚²¢—Ğ¢ö`¢G¶f÷&ÖE7V66W74çVÖ&W"€¢6†V6¶÷WG2æÆVæwF€¢—Ğ¢Â÷7ãà  ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'7V66W72Ö÷&FW"ÖæbÖ'WGFöâ ¢–CÒ'7V66W72Ö÷&FW"ÖæW‡B ¢G°¢7V66W746†V6¶÷WD–æFW‚ãĞ¢6†V6¶÷WG2æÆVæwF‚Ò¢ò&F—6&ÆVB ¢¢" ¢Ğ¢à¢æW‡B÷&FW"(i ¢Âö'WGFöãà ¢ÂöF—cà ¢ÂöF—cà¢°  ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'7V66W72Ö÷&FW"×&Wf–÷W2 ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢–b€¢7V66W746†V6¶÷WD–æFW‚ÃÒ ¢’°¢&WGW&ã°¢Ğ ¢7V66W746†V6¶÷WD–æFW‚ÓÒ° ¢&VæFW%7V66W746†V6¶÷WG2€¢6†V6¶÷WG0¢“°¢Ğ¢“°  ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'7V66W72Ö÷&FW"ÖæW‡B ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢–b€¢7V66W746†V6¶÷WD–æFW‚ãĞ¢6†V6¶÷WG2æÆVæwF‚Ò¢’°¢&WGW&ã°¢Ğ ¢7V66W746†V6¶÷WD–æFW‚³Ò° ¢&VæFW%7V66W746†V6¶÷WG2€¢6†V6¶÷WG0¢“°¢Ğ¢“°  ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'7V66W72ÖÆÂÖ÷&FW'2 ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢&VæFW%7V66W74ÆÄ÷&FW'2€¢6†V6¶÷WG0¢“°¢Ğ¢“°§Ğ  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢5T44U52(	BÄÂõ$DU%2d”Up£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦gVæ7F–öâ&VæFW%7V66W74ÆÄ÷&FW'2€¢6†V6¶÷WG2ÒµĞ¢’°¢6öç7B6öçF–æW"Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'7V66W72Ö6†V6¶÷WG2 ¢“° ¢–b‚6öçF–æW"’°¢&WGW&ã°¢Ğ  ¢6öç7B÷&FW'4‡FÖÂĞ¢6†V6¶÷WG0¢æÖ†6†V6¶÷WBÓâ°¢6öç7B&WF–ÆW"Ğ¢6†V6¶÷WBç&WF–ÆW"ÇÀ¢6†V6¶÷WBç7F÷&RÇÀ¢%&WF–ÆW"#°  ¢6öç7B÷&FW$çVÖ&W"Ğ¢6†V6¶÷WBæ÷&FW$çVÖ&W"ÇÀ¢6†V6¶÷WBæ÷&FW$–BÇÀ¢6†V6¶÷WBæ–BÇÀ¢"#°  ¢6öç7BFFRĞ¢6†V6¶÷WBæ6†V6¶÷WDBÇÀ¢6†V6¶÷WBæFFRÇÀ¢6†V6¶÷WBæ7&VFVDBÇÀ¢çVÆÃ°  ¢6öç7BVçF—G’Ğ¢ÖF‚æÖ‚€¢À¢çVÖ&W"€¢6†V6¶÷WBæ—FVÔ6÷VçBóğ¢6†V6¶÷WBçVçF—G’óğ¢6†V6¶÷WBçF÷FÄ—FV×2óğ¢ ¢’ÇÂ ¢“°  ¢6öç7BfÇVRĞ¢çVÖ&W"€¢6†V6¶÷WBæ÷&FW%F÷FÂóğ¢6†V6¶÷WBæ6†V6¶÷WEfÇVRóğ¢6†V6¶÷WBçfÇVRóğ¢6†V6¶÷WBçF÷FÂóğ¢6†V6¶÷WBæÖ÷VçBóğ¢ ¢’ÇÂ°  ¢6öç7B—FV×2Ğ¢vWE7V66W746†V6¶÷WD—FV×2€¢6†V6¶÷W@¢“°  ¢6öç7B—FVÕ&÷w2Ğ¢—FV×2æÆVæwF€¢ò—FV×0¢æÖ†—FVÒÓâ°¢6öç7BæÖRĞ¢—FVÒææÖRÇÀ¢—FVÒç&öGV7DæÖRÇÀ¢$—FVÒ#° ¢6öç7B—FVÕVçF—G’Ğ¢ÖF‚æÖ‚€¢À¢çVÖ&W"€¢—FVÒçVçF—G’óğ¢—FVÒçG’óğ¢¢’ÇÂ¢“° ¢6öç7B–ÖvRĞ¢vWE7V66W74—FVÔ–ÖvR€¢—FVĞ¢“° ¢&WGW&â ¢ÆF—`¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö—FVÒ ¢à ¢ÆF—`¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö—FVÒÖ–ÖvRG°¢–ÖvP¢ò" ¢¢'7V66W72×&öGV7B×Æ6V†öÆFW" ¢Ò ¢à ¢G°¢–ÖvP¢ò ¢Æ–Öp¢7&3Ò"G¶W66T‡FÖÂ€¢–ÖvP¢—Ò ¢ÇCÒ"G¶W66T‡FÖÂ€¢æÖP¢—Ò ¢ÆöF–æsÒ&Æ§’ ¢&VfW'&W'öÆ–7“Ò&æò×&VfW'&W" ¢óà¢ ¢¢ ¢Ç7ãà¢•DTĞ¢Â÷7ãà¢ ¢Ğ ¢ÂöF—cà  ¢ÆF—`¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö—FVÒÖæÖR ¢à¢G¶W66T‡FÖÂ€¢æÖP¢—Ğ¢ÂöF—cà  ¢Ç7G&öæp¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö—FVÒ×VçF—G’ ¢à¢9rG¶f÷&ÖE7V66W74çVÖ&W"€¢—FVÕVçF—G¢—Ğ¢Â÷7G&öæsà ¢ÂöF—cà¢°¢Ò¢æ¦ö–â‚""¢¢ ¢ÆF—`¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö—FVÒ ¢à ¢ÆF—`¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö—FVÒÖ–ÖvR7V66W72×&öGV7B×Æ6V†öÆFW" ¢à¢Ç7ãà¢•DTĞ¢Â÷7ãà¢ÂöF—cà ¢ÆF—`¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö—FVÒÖæÖR ¢à¢7V66W76gVÂ6†V6¶÷W@¢ÂöF—cà ¢Ç7G&öæp¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö—FVÒ×VçF—G’ ¢à¢9rG¶f÷&ÖE7V66W74çVÖ&W"€¢ÖF‚æÖ‚€¢À¢VçF—G¢¢—Ğ¢Â÷7G&öæsà ¢ÂöF—cà¢°  ¢&WGW&â ¢Æ'F–6ÆP¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö6&B ¢à ¢ÆF—`¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö†VB ¢à ¢ÆF—cà ¢Ç7à¢6Æ73Ò'7V66W72Ö6†V6¶÷WB×&WF–ÆW" ¢à¢G¶W66T‡FÖÂ€¢&WF–ÆW ¢—Ğ¢Â÷7ãà ¢ÆƒCà¢G¶W66T‡FÖÂ€¢f÷&ÖE7V66W74FFR€¢FFP¢¢—Ğ¢ÂöƒCà ¢G°¢÷&FW$çVÖ&W ¢ò ¢Çà¢÷&FW"2G¶W66T‡FÖÂ€¢÷&FW$çVÖ&W ¢—Ğ¢Â÷à¢ ¢¢" ¢Ğ ¢ÂöF—cà  ¢ÆF—`¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2×F÷FÂ ¢à¢Ç7ãà¢G¶f÷&ÖE7V66W74çVÖ&W"€¢VçF—G¢—Ğ¢G°¢VçF—G’ÓÓÒ¢ò&—FVÒ ¢¢&—FV×2 ¢Ğ¢Â÷7ãà ¢Ç7G&öæsà¢G¶W66T‡FÖÂ€¢f÷&ÖE7V66W747W'&Væ7’€¢fÇVP¢¢—Ğ¢Â÷7G&öæsà¢ÂöF—cà ¢ÂöF—cà  ¢ÆF—`¢6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2Ö—FV×2 ¢à¢G¶—FVÕ&÷w7Ğ¢ÂöF—cà ¢Âö'F–6ÆSà¢°¢Ò¢æ¦ö–â‚""“°  ¢6öçF–æW"æ–ææW$…DÔÂÒ ¢ÆF—b6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2×f–Wr#à ¢ÆF—b6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2×F—FÆR#à ¢ÆF—cà¢Ç7â6Æ73Ò&W–V'&÷r#à¢4„T4´õUB„•5Dõ%¢Â÷7ãà ¢Æƒ3à¢ÆÂ÷&FW'0¢Âöƒ3à ¢Çà¢WfW'’7–æ6‡&öæ—¦VB6†V6¶÷W@¢æBF†R&öGV7G26V7W&VB–à¢V6‚÷&FW"à¢Â÷à¢ÂöF—cà  ¢Æ'WGFöà¢G—SÒ&'WGFöâ ¢6Æ73Ò'7V66W72Ö÷&FW"ÖæbÖ'WGFöâ ¢–CÒ'7V66W72Ö&6²×Fò×&V6VçB ¢à¢(i&6²Fò&V6VçB7V66W70¢Âö'WGFöãà ¢ÂöF—cà  ¢ÆF—b6Æ73Ò'7V66W72ÖÆÂÖ÷&FW'2ÖÆ—7B#à¢G¶÷&FW'4‡FÖÇĞ¢ÂöF—cà ¢ÂöF—cà¢°  ¢Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢'7V66W72Ö&6²×Fò×&V6VçB ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢&VæFW%7V66W746†V6¶÷WG2€¢6†V6¶÷WG0¢“°¢Ğ¢“°§Ğ  ¦6öç7B7V66W74ÖWG&–5F–ÖW'2ÒæWrvV´Ö‚“°¦gVæ7F–öâ&öÆÅ7V66W74ÖWG&–2†–BÂfÇVRÂ7W'&Væ7’ÒfÇ6R’°¢6öç7BVÆVÖVçBÒFö7VÖVçBævWDVÆVÖVçD'”–B†–B“°¢–b‚VÆVÖVçB’&WGW&ã°¢6öç7BçVÖW&–2ÒçVÖ&W"‡fÇVR’ÇÂ°¢6öç7Bf÷&ÖGFVBÒ7W'&Væ7’òf÷&ÖE7V66W747W'&Væ7’†çVÖW&–2’¢f÷&ÖE7V66W74çVÖ&W"†çVÖW&–2“°¢6öç7B&Wf–÷W2ÒVÆVÖVçBæFF6WBç7V66W74ÖWG&–5fÇVS°¢–b‡&Wf–÷W2ÓÓÒ7G&–ær†çVÖW&–2’bbVÆVÖVçBæFF6WBç7V66W74ÖWG&–47W'&Væ7’ÓÓÒ7G&–ær†7W'&Væ7’’bbVÆVÖVçBçFW‡D6öçFVçBçG&–Ò‚’ÓÒ.(	B"’&WGW&ã°¢6öç7BöÆEFW‡BÒVÆVÖVçBçFW‡D6öçFVçBçG&–Ò‚’ÓÓÒ.(	B"ò.(	B"¢†VÆVÖVçBæFF6WBç7V66W74ÖWG&–5FW‡BÇÂVÆVÖVçBçFW‡D6öçFVçBçG&–Ò‚’“°¢VÆVÖVçBæFF6WBç7V66W74ÖWG&–5fÇVRÒ7G&–ær†çVÖW&–2“°¢VÆVÖVçBæFF6WBç7V66W74ÖWG&–47W'&Væ7’Ò7G&–ær†7W'&Væ7’“°¢VÆVÖVçBæFF6WBç7V66W74ÖWG&–5FW‡BÒf÷&ÖGFVC°¢6ÆV%F–ÖV÷WB‡7V66W74ÖWG&–5F–ÖW'2ævWB†VÆVÖVçB’“°¢–b‚&Wf–÷W2ÇÂöÆEFW‡BÓÓÒ.(	B"ÇÂFö7VÖVçBæ†–FFVâÇÂÖF6„ÖVF–‚"‡&VfW'2×&VGV6VBÖÖ÷F–öã¢&VGV6R’"’æÖF6†W2’°¢VÆVÖVçBçFW‡D6öçFVçBÒf÷&ÖGFVC°¢VÆVÖVçBç&VÖ÷fTGG&–'WFR‚&&–ÖÆ&VÂ"“°¢&WGW&ã°¢Ğ ¢VÆVÖVçBç&WÆ6T6†–ÆG&Vâ‚“°¢VÆVÖVçBç6WDGG&–'WFR‚&&–ÖÆ&VÂ"Âf÷&ÖGFVB“°¢6öç7BöÆDF–v—G2ÒöÆEFW‡Bç&WÆ6R‚õÄBörÂ""’ç7Æ—B‚""“°¢6öç7BæWtF–v—G2Òf÷&ÖGFVBç&WÆ6R‚õÄBörÂ""’ç7Æ—B‚""“°¢ÆWBF–v—D–æFW‚Ò°¢6öç7BG&6·2ÒµÓ°¢f÷"†6öç7B6†&7FW"öbf÷&ÖGFVB’°¢–b‚õÆBòçFW7B†6†&7FW"’’°¢6öç7B6W&F÷"ÒFö7VÖVçBæ7&VFTVÆVÖVçB‚'7â"“°¢6W&F÷"çFW‡D6öçFVçBÒ6†&7FW#°¢6W&F÷"ç6WDGG&–'WFR‚&&–Ö†–FFVâ"Â'G'VR"“°¢VÆVÖVçBæVæB‡6W&F÷"“°¢6öçF–çVS°¢Ğ¢6öç7BöÆDF–v—BÒçVÖ&W"†öÆDF–v—G5¶öÆDF–v—G2æÆVæwF‚ÒæWtF–v—G2æÆVæwF‚²F–v—D–æFW…Òóò“°¢F–v—D–æFW‚³Ò°¢6öç7BF&vWDF–v—BÒçVÖ&W"†6†&7FW"“°¢6öç7B7FW2Ò†öÆDF–v—BÒF&vWDF–v—B²’R°¢–b‚7FW2’°¢6öç7BF–v—BÒFö7VÖVçBæ7&VFTVÆVÖVçB‚'7â"“°¢F–v—BçFW‡D6öçFVçBÒ6†&7FW#°¢F–v—Bç6WDGG&–'WFR‚&&–Ö†–FFVâ"Â'G'VR"“°¢VÆVÖVçBæVæB†F–v—B“°¢6öçF–çVS°¢Ğ¢6öç7Bv–æF÷rÒFö7VÖVçBæ7&VFTVÆVÖVçB‚'7â"“°¢v–æF÷ræ6Æ74æÖRÒ'7V66W72ÖöFöÖWFW"×v–æF÷r#°¢v–æF÷rç6WDGG&–'WFR‚&&–Ö†–FFVâ"Â'G'VR"“°¢6öç7BG&6²ÒFö7VÖVçBæ7&VFTVÆVÖVçB‚'7â"“°¢G&6²æ6Æ74æÖRÒ'7V66W72ÖöFöÖWFW"×G&6²#°¢f÷"†ÆWB7FWÒ²7FWÃÒ7FW3²7FW³Ò’°¢6öç7Bf6RÒFö7VÖVçBæ7&VFTVÆVÖVçB‚'7â"“°¢f6RçFW‡D6öçFVçBÒ7G&–ær‚†öÆDF–v—BÒ7FW²’R“°¢G&6²æVæB†f6R“°¢Ğ¢v–æF÷ræVæB‡G&6²“°¢VÆVÖVçBæVæB‡v–æF÷r“°¢G&6·2çW6‚‡²G&6²Â7FW2Ò“°¢Ğ¢&WVW7Dæ–ÖF–öäg&ÖR‚‚’Óâ&WVW7Dæ–ÖF–öäg&ÖR‚‚’Óâ°¢G&6·2æf÷$V6‚‚‡²G&6²Â7FW2Ò’Óâ²G&6²ç7G–ÆRçG&ç6f÷&ÒÒG&ç6ÆFU’‚ÒG·7FW2¢ãWÖVÒ–²Ò“°¢Ò’“°¢7V66W74ÖWG&–5F–ÖW'2ç6WB†VÆVÖVçBÂ6WEF–ÖV÷WB‚‚’Óâ°¢–b†VÆVÖVçBæFF6WBç7V66W74ÖWG&–5FW‡BÓÓÒf÷&ÖGFVB’°¢VÆVÖVçBçFW‡D6öçFVçBÒf÷&ÖGFVC°¢VÆVÖVçBç&VÖ÷fTGG&–'WFR‚&&–ÖÆ&VÂ"“°¢Ğ¢ÒÂS’“°§Ğ ¦gVæ7F–öâ&VæFW%7V66W74F6†&ö&B€¢FFÒ·Ğ¢’°¢6öç7B7VÖÖ'’Ğ¢FFç7VÖÖ'’ÇÂ·Ó° ¢6öç7BF÷FÄ6†V6¶÷WG2Ğ¢çVÖ&W"€¢7VÖÖ'’çF÷FÄ6†V6¶÷WG2óğ¢FFçF÷FÄ6†V6¶÷WG2óğ¢ ¢’ÇÂ° ¢6öç7B—FV×56V7W&VBĞ¢çVÖ&W"€¢7VÖÖ'’æ—FV×56V7W&VBóğ¢7VÖÖ'’çF÷FÄ—FV×2óğ¢FFæ—FV×56V7W&VBóğ¢FFçF÷FÄ—FV×2óğ¢ ¢’ÇÂ° ¢6öç7B6†V6¶÷WEfÇVRĞ¢çVÖ&W"€¢7VÖÖ'’æ6†V6¶÷WEfÇVRóğ¢7VÖÖ'’çF÷FÅfÇVRóğ¢FFæ6†V6¶÷WEfÇVRóğ¢FFçF÷FÅfÇVRóğ¢ ¢’ÇÂ° ¢6öç7B&W7DF’Ğ¢7VÖÖ'’æ&W7DF’óğ¢FFæ&W7DF’óğ¢çVÆÃ° ¢&öÆÅ7V66W74ÖWG&–2‚'7V66W72×F÷FÂÖ6†V6¶÷WG2"ÂF÷FÄ6†V6¶÷WG2“° ¢&öÆÅ7V66W74ÖWG&–2‚'7V66W72×F÷FÂÖ—FV×2"Â—FV×56V7W&VB“° ¢&öÆÅ7V66W74ÖWG&–2‚'7V66W72×F÷FÂ×fÇVR"Â6†V6¶÷WEfÇVRÂG'VR“° ¢6WE7V66W75FW‡B€¢'7V66W72Ö&W7BÖF’"À¢çVÖ&W"æ—4f–æ—FR€¢çVÖ&W"†&W7DF’¢¢ò7G&–ær€¢çVÖ&W"†&W7DF’¢¢¢.(	B ¢“° ¢6öç7B7–æ2Ğ¢FFç7–æ2ÇÂ·Ó° ¢6öç7B7–æ57FGW2Ğ¢7–æ2ç7FGW2ÇÀ¢FFç7–æ57FGW2ÇÀ¢$æ÷B6öææV7FVB#° ¢6WE7V66W75FW‡B€¢'7V66W72×7–æ2×7FGW2"À¢7–æ57FGW0¢“° ¢6öç7B7–æ5WFFVBĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'7V66W72×7–æ2×WFFVB ¢“° ¢–b‡7–æ5WFFVB’°¢6öç7BÆ7E7–æ2Ğ¢7–æ2æÆ7E7–æ6VDBÇÀ¢FFæÆ7E7–æ6VDBÇÀ¢çVÆÃ° ¢7–æ5WFFVBçFW‡D6öçFVçBĞ¢Æ7E7–æ0¢òÆ7B7–æ6‡&öæ—¦VBG¶f÷&ÖE7V66W74FFR€¢Æ7E7–æ0¢—Ö ¢¢$6†V6¶÷WB7–æ6‡&öæ—¦F–öâ†2æ÷B'Vâ–WBâ#°¢Ğ ¢&VæFW%7V66W746†'B€¢'&’æ—4'&’†FFæ7F—f—G’¢òFFæ7F—f—G¢¢µĞ¢“° ¢&VæFW%7V66W746†V6¶÷WG2€¢'&’æ—4'&’€¢FFç&V6VçD6†V6¶÷WG0¢¢òFFç&V6VçD6†V6¶÷WG0¢¢€¢'&’æ—4'&’€¢FFæ6†V6¶÷WG0¢¢òFFæ6†V6¶÷WG0¢¢µĞ¢¢“°§Ğ  ¦gVæ7F–öâ&VæFW%7V66W74ÆöF–ær‚’°¢6WE7V66W75FW‡B€¢'7V66W72×F÷FÂÖ6†V6¶÷WG2"À¢.(	B ¢“° ¢6WE7V66W75FW‡B€¢'7V66W72×F÷FÂÖ—FV×2"À¢.(	B ¢“° ¢6WE7V66W75FW‡B€¢'7V66W72×F÷FÂ×fÇVR"À¢.(	B ¢“° ¢6WE7V66W75FW‡B€¢'7V66W72Ö&W7BÖF’"À¢.(	B ¢“° ¢6WE7V66W75FW‡B€¢'7V66W72×7–æ2×7FGW2"À¢$ÆöF–æ~(
b ¢“°§Ğ  ¦gVæ7F–öâ&VæFW%7V66W74W'&÷"€¢ÖW76vP¢’°¢6WE7V66W75FW‡B€¢'7V66W72×7–æ2×7FGW2"À¢%Væf–Æ&ÆR ¢“° ¢6öç7B6öçF–æW"Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢'7V66W72Ö6†V6¶÷WG2 ¢“° ¢–b†6öçF–æW"’°¢6öçF–æW"æ–ææW$…DÔÂÒ ¢ÆF—b6Æ73Ò'7V66W72ÖV×G’#à¢Ç7G&öæsà¢7V66W72FF6÷VÆBæ÷B&RÆöFVBà¢Â÷7G&öæsà ¢Çà¢G¶W66T‡FÖÂ€¢ÖW76vRÇÀ¢%ÆV6RG'’v–ââ ¢—Ğ¢Â÷à¢ÂöF—cà¢°¢Ğ§Ğ  ¦7–æ2gVæ7F–öâÆöE7V66W74F6†&ö&B€¢f÷&6RÒfÇ6P¢’°¢–b…5T44U55ôDTÔõôÔôDR’°¢7V66W757FFRæFFÒ†öÖWvU6×ÆU7V66W74FF‚“°¢7V66W757FFRæÆöFVBÒG'VS°¢7V66W757FFRæÆöF–ærÒfÇ6S°¢&VæFW%7V66W74F6†&ö&B‡7V66W757FFRæFF“°¢&WGW&ã°¢Ğ¢–b„DÔ”åõ$Ud”UuôÔôDR’°¢7V66W757FFRæFFÒFÖ–å&Wf–Wu7V66W74FF‚“°¢7V66W757FFRæÆöFVBÒG'VS°¢7V66W757FFRæÆöF–ærÒfÇ6S°¢&VæFW%7V66W74F6†&ö&B‡7V66W757FFRæFF“°¢&WGW&ã°¢Ğ¢–b€¢7V66W757FFRæÆöF–æp¢’°¢&WGW&ã°¢Ğ ¢–b€¢7V66W757FFRæÆöFVBb`¢f÷&6P¢’°¢&VæFW%7V66W74F6†&ö&B€¢7V66W757FFRæFFÇÂ·Ğ¢“° ¢&WGW&ã°¢Ğ ¢7V66W757FFRæÆöF–ærÒG'VS° ¢&VæFW%7V66W74ÆöF–ær‚“° ¢G'’°¢6öç7B7V66W75FW7DÖöFRĞ¢æWrU$Å6V&6…&×2€¢v–æF÷ræÆö6F–öâç6V&6€¢’ævWB‚'7V66W75FW7B"’ÓÓÒ##° ¢6öç7B&ævRĞ¢vWE7V66W75&ævR‚“° ¢6öç7BVW'’Ğ¢æWrU$Å6V&6…&×2‡°¢7F'C ¢&ævRç7F'BÀ ¢VæC ¢&ævRæVæ@¢Ò“° ¢ò ¢¶VWF†RW†—7F–ærFV×÷&'¢FÖ–âFW7B'&–FvR–çF7Bà ¢&öGV7F–öâ7W7FöÖW"7V66W70¢&WVW7G2W6RF†RæWrFFR×&ævP¢&ÖWFW'2à¢¢ğ¢6öç7B7V66W74VæGö–çBĞ¢7V66W75FW7DÖöFP¢ò"ö’öFÖ–â÷FW7B×7V66W72 ¢¢ö’ö66÷VçB÷7V66W73òG·VW'’çFõ7G&–ær‚—Ö° ¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢7V66W74VæGö–çBÀ¢°¢ÖWF†öC¢$tUB"À ¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À ¢66†S ¢&æò×7F÷&R ¢Ğ¢“° ¢6öç7BFFĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b€¢&W7öç6Rç7FGW2ÓÓÒC¢’°¢F‡&÷ræWrW'&÷"€¢%ÆV6R6–vâ–âFòf–Wr–÷W"7V66W72F6†&ö&Bâ ¢“°¢Ğ ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢FFæW'&÷"ÇÀ¢%Væ&ÆRFòÆöB7V66W72FFâ ¢“°¢Ğ ¢ò ¢&öGV7F–öâ&WGW&ç2F†R7GVÀ¢66WFVB&ævRâ¶VWF†R'&÷w6W ¢7–æ6‡&öæ—¦VBv—F‚—Bà¢¢ğ¢–b€¢7V66W75FW7DÖöFRb`¢FFç&ævSòç7F'Bb`¢FFç&ævSòæVæ@¢’°¢7V66W757FFRç&ævU7F'BĞ¢FFç&ævRç7F'C° ¢7V66W757FFRç&ævTVæBĞ¢FFç&ævRæVæC°¢Ğ ¢7V66W757FFRæFFĞ¢FFÇÂ·Ó° ¢7V66W757FFRæÆöFVBĞ¢G'VS° ¢&VæFW%7V66W74F6†&ö&B€¢7V66W757FFRæFF¢“° ¢Ò6F6‚†W'&÷"’°¢7V66W757FFRæÆöFVBĞ¢fÇ6S° ¢&VæFW%7V66W74W'&÷"€¢W'&÷"æÖW76vP¢“° ¢Òf–æÆÇ’°¢7V66W757FFRæÆöF–ærĞ¢fÇ6S°¢Ğ§Ğ  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢ÄôB5T44U52t„Tâ5T44U52D"õTå0£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦Fö7VÖVç@¢çVW'•6VÆV7F÷$ÆÂ€¢%¶FFÖ66÷VçB×F%Ò ¢¢æf÷$V6‚†'WGFöâÓâ°¢'WGFöâæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢–b€¢'WGFöâæFF6W@¢æ66÷VçEF"ÓÓĞ¢'7V66W72 ¢’°¢ÆöE7V66W74F6†&ö&B‡G'VR“°¢Ğ¢Ğ¢“°¢Ò“° ¢òò&Vg&W6‚öæÇ’v†–ÆRF†R7W7FöÖW"—2Æöö¶–ærBF†R7V66W72F"à§6WD–çFW'fÂ‚‚’Óâ°¢6öç7BæVÂÒFö7VÖVçBævWDVÆVÖVçD'”–B‚&66÷VçB×F"×7V66W72"“°¢–b†Fö7VÖVçBçf—6–&–Æ—G•7FFRÓÓÒ'f—6–&ÆR"bbæVÂbbæVÂæ†–FFVâbbFö7VÖVçBævWDVÆVÖVçD'”–B‚&×’×&öf–ÆR"“òæ6Æ74Æ—7Bæ6öçF–ç2‚&7F—fR"’’°¢ÆöE7V66W74F6†&ö&B‡G'VR“°¢Ğ§ÒÂc¢“°¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢ÄôB$UD”ÄU"$ôd”ÄU2t„Tâ$ôd”ÄU2D"õTå0£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦Fö7VÖVç@¢çVW'•6VÆV7F÷$ÆÂ€¢%¶FFÖ66÷VçB×F%Ò ¢¢æf÷$V6‚†'WGFöâÓâ°¢'WGFöâæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢ò ¢–÷W"…DÔÂ¶VW2F†R–çFW&æÂF"fÇVP¢&VF—B×&öf–ÆR"f÷"6ö×F–&–Æ—G’Âv†–ÆP¢F†Rf—6–&ÆRÆ&VÂ—2%&öf–ÆW2"à¢¢ğ ¢–b€¢'WGFöâæFF6W@¢æ66÷VçEF"ÓÓĞ¢&VF—B×&öf–ÆR ¢’°¢ÆöE&WF–ÆW%&öf–ÆW2‚“°¢ÆöDÖævVDÖVÖ&W'6†—2‚“°¢ÆöE6fVDFWF–Ç2‚“°¢Ğ¢Ğ¢“°¢Ò“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢ÄôBd”Ä$”Ä•E’t„TâD"õTå0£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦Fö7VÖVç@¢çVW'•6VÆV7F÷$ÆÂ€¢%¶FFÖ66÷VçB×F%Ò ¢¢æf÷$V6‚†'WGFöâÓâ°¢'WGFöâæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢–b€¢'WGFöâæFF6W@¢æ66÷VçEF"ÓÓĞ¢&f–Æ&–Æ—G’ ¢’°¢ÆöDÖævVDf–Æ&–Æ—G”7W7FöÖW"‚“°¢Ğ¢Ğ¢“°¢Ò“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢ÄôBÕ’$ôd”ÄP£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦7–æ2gVæ7F–öâÆöDÖVÖ&W%&öf–ÆR€¢f÷&6RÒfÇ6P¢’°¢–b„DÔ”åõ$Ud”UuôÔôDR’°¢'V–ÆDFÖ–å&Wf–Wu&öf–ÆR‚“°¢&WGW&ã°¢Ğ¢–b€¢7FFRç&öf–ÆTÆöFVBb`¢f÷&6Rb`¢7FFRæ7W7FöÖW ¢’°¢6†÷u6–væVD–â‚“°¢&WGW&ã°¢Ğ ¢G'’°¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö×’×&öf–ÆR"À¢°¢ÖWF†öC¢$tUB"À ¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À ¢66†S ¢&æò×7F÷&R ¢Ğ¢“° ¢–b€¢&W7öç6Rç7FGW2ÓÓÒC¢’°¢6†÷u6–væVD÷WB‚“° ¢–b‡&W6WEFö¶Vâ’°¢6†÷u77v÷&E&W6WB‚“°¢Ğ ¢&WGW&ã°¢Ğ ¢6öç7BFFĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢FFæW'&÷"ÇÀ¢%Væ&ÆRFòÆöB–÷W"7W7FöÖW"&öf–ÆRâ ¢“°¢Ğ ¢7FFRæ7W7FöÖW"Ğ¢FFæ66÷VçBÇÂçVÆÃ° ¢&VæFW$7W7FöÖW$F—66÷&E6WGF–æw2‚“° ¢v—BÆöD7W7FöÖW$æ÷F–f–6F–öç2‚“° ¢7FFRæ66÷VçE7FG2Ğ¢FFæ66÷VçE7FG2ÇÂ°¢W6W%6–æ6S ¢FFæ66÷VçCòæ7&VFVDBÇÀ¢çVÆÂÀ¢F—7Æ”æÖS ¢$ÖVÖ&W""À¢ötÖVÖ&W# ¢fÇ6RÀ¢Æ–fWF–ÖU7VæC ¢À¢F÷FÄ÷&FW'3 ¢ ¢Ó° ¢7FFRæ÷&FW'2Ğ¢'&’æ—4'&’€¢FFæ÷&FW'0¢¢òFFæ÷&FW'0¢¢µÓ° ¢7FFRç&öf–ÆTÆöFVBÒG'VS° ¢6†÷u6–væVD–â‚“° ¢&VæFW$66÷VçD†VFW"€¢7FFRæ7W7FöÖW ¢“° ¢7FFRæÖVÖ&W'6†—Ğ¢FFæÖVÖ&W'6†—ÇÀ¢FFæ7W'&VçDÖVÖ&W'6†—ÇÀ¢çVÆÃ° §&VæFW$ÖVÖ&W'6†—€¢7FFRæÖVÖ&W'6†— ¢“° §WFFU&VçFÄÖVÖ&W'6†—66W72€¢7FFRæÖVÖ&W'6†— ¢“° §WFFU&–6–æuWw&FT'WGFöç2‚“° §7FFRç&WF–ÆW$ÆÆ÷væ6RĞ¢ÖF‚æÖ‚€¢À¢çVÖ&W"€¢FFç&öf–ÆTÆÆ÷væ6P¢’ÇÂ ¢“° §7FFRç&WF–ÆW%&öf–ÆW4ÆöFVBĞ¢fÇ6S° ¦v—BÆöDÖævVDÖVÖ&W'6†—2‚“° ¦v—BÆöDÖævVDf–Æ&–Æ—G”7W7FöÖW"‚“° ¦v—BÆöE6fVDFWF–Ç2‚“° §&VæFW$÷&FW'2€¢7FFRæ÷&FW'0¢“° ¢÷VÆFTVF—D÷&FW%6VÆV7B€¢7FFRæ÷&FW'0¢“° §Ò6F6‚†W'&÷"’°¢7FFRç&öf–ÆTÆöFVBĞ¢fÇ6S° ¢6öç6öÆRæW'&÷"€¢$×’&öf–ÆRÆöBW'&÷#¢"À¢W'&÷ ¢“° ¢–b‡7FFRæ7W7FöÖW"’°¢6†÷u6–væVD–â‚“°¢ÒVÇ6R°¢6†÷u6–væVD÷WB‚“°¢Ğ ¢6†÷t66÷VçDÖW76vR€¢W'&÷"æÖW76vRÀ¢&W'&÷" ¢“°§Ğ§Ğ  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢5U5DôÔU"D•44õ$B4UED”äu2²äõD”d”4D”ôå0£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦gVæ7F–öâ&VæFW$7W7FöÖW$F—66÷&E6WGF–æw2‚’°¢6öç7Bf÷&ÒĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&F—66÷&B×6WGF–æw2Öf÷&Ò ¢“° ¢–b‚f÷&Ò’°¢&WGW&ã°¢Ğ ¢6öç7BW6W&æÖRĞ¢f÷&ÒçVW'•6VÆV7F÷"€¢u¶æÖSÒ&F—66÷&EW6W&æÖR%Òp¢“° ¢6öç7BW6W$–BĞ¢f÷&ÒçVW'•6VÆV7F÷"€¢u¶æÖSÒ&F—66÷&EW6W$–B%Òp¢“° ¢–b‡W6W&æÖR’°¢W6W&æÖRçfÇVRĞ¢7FFRæ7W7FöÖW ¢òæF—66÷&EW6W&æÖRÇÀ¢"#°¢Ğ ¢–b‡W6W$–B’°¢W6W$–BçfÇVRĞ¢7FFRæ7W7FöÖW ¢òæF—66÷&EW6W$–BÇÀ¢"#°¢Ğ¢6öç7B&öÆU7FGW2ÒFö7VÖVçBævWDVÆVÖVçD'”–B‚&F—66÷&B×&öÆR×7FGW2"“°¢–b‡&öÆU7FGW2’&öÆU7FGW2çFW‡D6öçFVçBÒ7FFRæ7W7FöÖW#òæF—66÷&DÆ–æ¶V@¢ò$F—66÷&BÆ–æ¶VBâ–÷W"&öÆRföÆÆ÷w2–÷W"7F—fRÖVÖ&W'6†—â ¢¢$F—66÷&B—2æ÷BÆ–æ¶VB–WBâ#°§Ğ ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚&F—66÷&BÖÆ–æ²Ö'WGFöâ"“òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â7–æ2WfVçBÓâ°¢6öç7B'WGFöâÒWfVçBæ7W'&VçEF&vWC°¢6öç7B–ç7G'V7F–öç2ÒFö7VÖVçBævWDVÆVÖVçD'”–B‚&F—66÷&BÖÆ–æ²Ö–ç7G'V7F–öç2"“°¢G'’°¢6WD'WGFöä'W7’†'WGFöâÂG'VRÂ$vVæW&F–ærâââ"“°¢6öç7B&W7öç6RÒv—BfWF6‚‚"ö’ö66÷VçBöF—66÷&BÖÆ–æ²"Â²ÖWF†öC¢%õ5B"Â7&VFVçF–Ç3¢'6ÖRÖ÷&–v–â"Ò“°¢6öç7B&W7VÇBÒv—B&VD§6öâ‡&W7öç6R“°¢–b‚&W7öç6Ræö²’F‡&÷ræWrW'&÷"‡&W7VÇBæW'&÷"ÇÂ%Væ&ÆRFòvVæW&FRF—66÷&B6öFRâ"“°¢–ç7G'V7F–öç2ç&WÆ6T6†–ÆG&Vâ‚“°¢–ç7G'V7F–öç2æVæB‚$–âF†R6W'fW"ÂVçFW"öÆ–æ²æB7FRF†—26öFS¢"“°¢6öç7B6öFRÒFö7VÖVçBæ7&VFTVÆVÖVçB‚'7G&öær"“°¢6öFRçFW‡D6öçFVçBÒ&W7VÇBæ6öFS°¢–ç7G'V7F–öç2æVæB†6öFRÂ"âW‡—&W2–âÖ–çWFW2â¶VWF†R6öFR&—fFRâ"“°¢Ò6F6‚†W'&÷"’°¢–ç7G'V7F–öç2çFW‡D6öçFVçBÒW'&÷"æÖW76vS°¢Òf–æÆÇ’°¢6WD'WGFöä'W7’†'WGFöâÂfÇ6RÂ$vWBF—66÷&BÆ–æ²6öFR"“°¢Ğ§Ò“°  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&F—66÷&B×6WGF–æw2Öf÷&Ò ¢¢òæFDWfVçDÆ—7FVæW"€¢'7V&Ö—B"À¢7–æ2WfVçBÓâ°¢WfVçBç&WfVçDFVfVÇB‚“° ¢6öç7Bf÷&ÒĞ¢WfVçBæ7W'&VçEF&vWC° ¢6öç7B'WGFöâĞ¢f÷&ÒçVW'•6VÆV7F÷"€¢v'WGFöå·G—SÒ'7V&Ö—B%Òp¢“° ¢6öç7BFFĞ¢ö&¦V7Bæg&öÔVçG&–W2€¢æWrf÷&ÔFF€¢f÷&Ğ¢’æVçG&–W2‚¢“° ¢G'’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢G'VRÀ¢%6f–ærâââ ¢“° ¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö66÷VçBöF—66÷&B"À¢°¢ÖWF†öC ¢%UB"À ¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À ¢†VFW'3¢°¢$6öçFVçBÕG—R# ¢&Æ–6F–öâö§6öâ ¢ÒÀ ¢&öG“ ¢¥4ôâç7G&–æv–g’‡°¢F—66÷&EW6W&æÖS ¢7G&–ær€¢FFæF—66÷&EW6W&æÖRÇÀ¢" ¢’çG&–Ò‚¢Ò¢Ğ¢“° ¢6öç7B&W7VÇBĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢&W7VÇBæW'&÷"ÇÀ¢%Væ&ÆRFò6fRF—66÷&B–æf÷&ÖF–öââ ¢“°¢Ğ ¢7FFRæ7W7FöÖW"Ğ¢&W7VÇBæ66÷VçBÇÀ¢7FFRæ7W7FöÖW#° ¢&VæFW$7W7FöÖW$F—66÷&E6WGF–æw2‚“° ¢6†÷t66÷VçDÖW76vR€¢$F—66÷&B–æf÷&ÖF–öâ6fVBâ"À¢'7V66W72 ¢“° ¢Ò6F6‚†W'&÷"’°¢6†÷t66÷VçDÖW76vR€¢W'&÷"æÖW76vRÀ¢&W'&÷" ¢“° ¢Òf–æÆÇ’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢fÇ6RÀ¢%6fRF—66÷&B–æfò ¢“°¢Ğ¢Ğ¢“°  ¦gVæ7F–öâ7W7FöÖW$æ÷F–f–6F–öä6&D‡FÖÂ€¢æ÷F–f–6F–öà¢’°¢6öç7BF—FÆRĞ¢æ÷F–f–6F–öãòçF—FÆRÇÀ¢€¢æ÷F–f–6F–öãòæ¶–æBÓÓĞ¢&Ö—76–æuö–æfò ¢ò$7F–öâæVVFVB ¢¢$æ÷F–f–6F–öâ ¢“° ¢6öç7BÖW76vRĞ¢7G&–ær€¢æ÷F–f–6F–öãòæÖW76vRÇÀ¢" ¢“° ¢6öç7B7&VFVBĞ¢æ÷F–f–6F–öãòæ7&VFVD@¢òf÷&ÖDFFR€¢æ÷F–f–6F–öâæ7&VFVD@¢¢¢"#° ¢&WGW&â ¢Æ'F–6ÆR6Æ73Ò&7W7FöÖW"Öæ÷F–f–6F–öâÖ—FVÒ#à¢ÆF—b6Æ73Ò&7W7FöÖW"Öæ÷F–f–6F–öâÖ—FVÒÖ†VB#à¢ÆF—cà¢Ç7â6Æ73Ò&W–V'&÷r#à¢G°¢æ÷F–f–6F–öãòæ¶–æBÓÓĞ¢&Ö—76–æuö–æfò ¢ò$5D”ôâäTTDTB ¢¢$ÔU54tR ¢Ğ¢Â÷7ãà ¢ÆƒCà¢G¶W66T‡FÖÂ€¢F—FÆP¢—Ğ¢ÂöƒCà¢ÂöF—cà ¢G°¢7&VFV@¢ò ¢Ç6ÖÆÃà¢G¶W66T‡FÖÂ€¢7&VFV@¢—Ğ¢Â÷6ÖÆÃà¢ ¢¢" ¢Ğ¢ÂöF—cà ¢Çà¢G¶W66T‡FÖÂ€¢ÖW76vP¢’ç&WÆ6R€¢õÆâörÀ¢#Æ'#â ¢—Ğ¢Â÷à¢Âö'F–6ÆSà¢°§Ğ  ¦gVæ7F–öâWFFT7W7FöÖW$æ÷F–f–6F–öä–æF–6F÷"€¢6÷Vç@¢’°¢6öç7B†4æ÷F–f–6F–öç2Ğ¢çVÖ&W"†6÷VçB’â° ¢6öç7BÆ–v‡G2Ò°¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&66÷VçBÖæ÷F–f–6F–öâÖÆ–v‡B ¢’À¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öâ×7FGW2ÖÆ–v‡B ¢¢Ó° ¢f÷"€¢6öç7BÆ–v‡Bö`¢Æ–v‡G0¢’°¢–b‚Æ–v‡B’°¢6öçF–çVS°¢Ğ ¢Æ–v‡Bæ6Æ74Æ—7BçFövvÆR€¢&ÆW'B"À¢†4æ÷F–f–6F–öç0¢“° ¢Æ–v‡Bæ6Æ74Æ—7BçFövvÆR€¢&6ÆV""À¢†4æ÷F–f–6F–öç0¢“° ¢Æ–v‡Bç6WDGG&–'WFR€¢&&–ÖÆ&VÂ"À¢†4æ÷F–f–6F–öç0¢òG¶6÷VçGÒæ÷F–f–6F–öâG¶6÷VçBÓÓÒò""¢'2'Ö ¢¢$æòæ÷F–f–6F–öç2 ¢“°¢Ğ ¢6öç7BFW‡BĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öâ×7FGW2×FW‡B ¢“° ¢–b‡FW‡B’°¢FW‡BçFW‡D6öçFVçBĞ¢†4æ÷F–f–6F–öç0¢òG¶6÷VçGÒæ÷F–f–6F–öâG¶6÷VçBÓÓÒò""¢'2'Ö ¢¢$æòæ÷F–f–6F–öç2#°¢Ğ§Ğ  ¦gVæ7F–öâ6†÷t7W7FöÖW$æ÷F–f–6F–öå÷W€¢æ÷F–f–6F–öà¢’°¢6öç7B÷WĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öâ×÷W ¢“° ¢–b€¢÷WÇÀ¢æ÷F–f–6F–öà¢’°¢&WGW&ã°¢Ğ ¢6öç7BF—FÆRĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öâ×÷W×F—FÆR ¢“° ¢6öç7BÖW76vRĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öâ×÷WÖÖW76vR ¢“° ¢–b‡F—FÆR’°¢F—FÆRçFW‡D6öçFVçBĞ¢æ÷F–f–6F–öâçF—FÆRÇÀ¢$7F–öâæVVFVB#°¢Ğ ¢–b†ÖW76vR’°¢ÖW76vRæ–ææW$…DÔÂĞ¢W66T‡FÖÂ€¢æ÷F–f–6F–öâæÖW76vRÇÀ¢" ¢’ç&WÆ6R€¢õÆâörÀ¢#Æ'#â ¢“°¢Ğ ¢÷Wæ†–FFVâĞ¢fÇ6S°§Ğ  ¦7–æ2gVæ7F–öâÆöD7W7FöÖW$æ÷F–f–6F–öç2€¢°¢6†÷u÷WÒG'VP¢ÒÒ·Ğ¢’°¢–b‚7FFRæ7W7FöÖW"’°¢WFFT7W7FöÖW$æ÷F–f–6F–öä–æF–6F÷"€¢ ¢“°¢&WGW&ã°¢Ğ ¢G'’°¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö66÷VçBöæ÷F–f–6F–öç2"À¢°¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â"À¢66†S ¢&æò×7F÷&R ¢Ğ¢“° ¢6öç7BFFĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢FFæW'&÷"ÇÀ¢%Væ&ÆRFòÆöBæ÷F–f–6F–öç2â ¢“°¢Ğ ¢6öç7Bæ÷F–f–6F–öç2Ğ¢'&’æ—4'&’€¢FFææ÷F–f–6F–öç0¢¢òFFææ÷F–f–6F–öç0¢¢µÓ° ¢7FFRæ7W7FöÖW$æ÷F–f–6F–öç2Ğ¢æ÷F–f–6F–öç3° ¢WFFT7W7FöÖW$æ÷F–f–6F–öä–æF–6F÷"€¢æ÷F–f–6F–öç2æÆVæwF€¢“° ¢6öç7BÆ—7BĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öç2ÖÆ—7B ¢“° ¢–b†Æ—7B’°¢Æ—7Bæ–ææW$…DÔÂĞ¢æ÷F–f–6F–öç2æÆVæwF€¢òæ÷F–f–6F–öç0¢æÖ€¢7W7FöÖW$æ÷F–f–6F–öä6&D‡FÖÀ¢¢æ¦ö–â‚""¢¢ ¢Ç6Æ73Ò&66÷VçBÖ×WFVB#à¢æòæ÷F–f–6F–öç2à¢Â÷à¢°¢Ğ ¢–b€¢6†÷u÷Wb`¢æ÷F–f–6F–öç2æÆVæwF€¢’°¢6†÷t7W7FöÖW$æ÷F–f–6F–öå÷W€¢æ÷F–f–6F–öç5³Ğ¢“°¢Ğ ¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"€¢$7W7FöÖW"æ÷F–f–6F–öç2W'&÷#¢"À¢W'&÷ ¢“°¢Ğ§Ğ  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&6ÆV"Ö7W7FöÖW"Öæ÷F–f–6F–öç2 ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢7–æ2WfVçBÓâ°¢6öç7B'WGFöâĞ¢WfVçBæ7W'&VçEF&vWC° ¢G'’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢G'VRÀ¢$6ÆV&–ærâââ ¢“° ¢6öç7B&W7öç6RĞ¢v—BfWF6‚€¢"ö’ö66÷VçBöæ÷F–f–6F–öç2"À¢°¢ÖWF†öC ¢$DTÄUDR"À ¢7&VFVçF–Ç3 ¢'6ÖRÖ÷&–v–â ¢Ğ¢“° ¢6öç7BFFĞ¢v—B&VD§6öâ€¢&W7öç6P¢“° ¢–b‚&W7öç6Ræö²’°¢F‡&÷ræWrW'&÷"€¢FFæW'&÷"ÇÀ¢%Væ&ÆRFò6ÆV"æ÷F–f–6F–öç2â ¢“°¢Ğ ¢7FFRæ7W7FöÖW$æ÷F–f–6F–öç2Ğ¢µÓ° ¢WFFT7W7FöÖW$æ÷F–f–6F–öä–æF–6F÷"€¢ ¢“° ¢6öç7BÆ—7BĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öç2ÖÆ—7B ¢“° ¢–b†Æ—7B’°¢Æ—7Bæ–ææW$…DÔÂÒ ¢Ç6Æ73Ò&66÷VçBÖ×WFVB#à¢æòæ÷F–f–6F–öç2à¢Â÷à¢°¢Ğ ¢6öç7B÷WĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öâ×÷W ¢“° ¢–b‡÷W’°¢÷Wæ†–FFVâĞ¢G'VS°¢Ğ ¢Ò6F6‚†W'&÷"’°¢6†÷t66÷VçDÖW76vR€¢W'&÷"æÖW76vRÀ¢&W'&÷" ¢“° ¢Òf–æÆÇ’°¢6WD'WGFöä'W7’€¢'WGFöâÀ¢fÇ6RÀ¢$6ÆV"æ÷F–f–6F–öç2 ¢“°¢Ğ¢Ğ¢“°  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&6Æ÷6RÖ7W7FöÖW"Öæ÷F–f–6F–öâ×÷W ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6öç7B÷WĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öâ×÷W ¢“° ¢–b‡÷W’°¢÷Wæ†–FFVâĞ¢G'VS°¢Ğ¢Ğ¢“°  ¦Fö7VÖVç@¢ævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öâÖ÷Vâ×&öf–ÆR ¢¢òæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢‚’Óâ°¢6öç7B÷WĞ¢Fö7VÖVçBævWDVÆVÖVçD'”–B€¢&7W7FöÖW"Öæ÷F–f–6F–öâ×÷W ¢“° ¢–b‡÷W’°¢÷Wæ†–FFVâĞ¢G'VS°¢Ğ¢Ğ¢“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢4T5U$RÄ”ä²5D%EU £ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ ¦7–æ2gVæ7F–öâ&ö6W756V7W&TÆ–æ·2‚’°¢–b‡&W6WEFö¶Vâ’°¢6†÷u77v÷&E&W6WB‚“°¢&WGW&ã°¢Ğ ¢–b‡fW&–g”VÖ–ÅFö¶Vâ’°¢v—BfW&–g”7W7FöÖW$VÖ–Â€¢fW&–g”VÖ–ÅFö¶Và¢“° ¢&WGW&ã°¢Ğ ¢–b†6Æ–ÕFö¶Vâ’°¢v—BfW&–g”÷&FW$6Æ–Ò€¢6Æ–ÕFö¶Và¢“°¢Ğ§Ğ  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢”ä•D”Ä•¤P£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ §&VæFW%&–6–ær‚“° §WFFU6VÆV7FVEÆâ‚“° §WFFT6'B‚“° ¦–b„DÔ”åõ$Ud”UuôÔôDR’°¢Vç7W&TFÖ–å&Wf–Wt&ææW"‚“°§Ğ   ¦6öç7B–æ—F–ÅvRĞ¢Æö6F–öâæ†6‚ç6Æ–6Rƒ“° ¦–b€¢dÄ”EõtU2æ–æ6ÇVFW2€¢–æ—F–ÅvP¢¢’°¢vò†–æ—F–ÅvR“°§ÒVÇ6R°¢vò‚&†öÖR"“°§Ğ  §&ö6W756V7W&TÆ–æ·2‚“°  ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢U%4•5B5U5DôÔU"E$õDõtâòD"5DDU0¢6f–ær÷"&W&VæFW&–ærFöW2æ÷B6Æ÷6RæVÂà£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ¢†gVæ7F–öâ6WGW7W7FöÖW%W'6—7FVçDFWF–Ç2‚’°¢6öç7B7F÷&vU&Vf—‚Ğ¢'6ærÖ7W7FöÖW"ÖFWF–Ç3¢#° ¢gVæ7F–öâFWF–Ä¶W’€¢FWF–ÂÀ¢–æFW‚Ò ¢’°¢6öç7BW‡Æ–6—BĞ¢FWF–Âæ–BÇÀ¢FWF–ÂæFF6W@¢òç&öf–ÆTw&÷WÇÀ¢FWF–ÂæFF6W@¢òæÖævVE&öf–ÆRÇÀ¢"#° ¢6öç7B7VÖÖ'’Ğ¢FWF–ÂçVW'•6VÆV7F÷"€¢#§66÷Râ7VÖÖ'’ ¢“òæ–ææW%FW‡@¢òç&WÆ6R‚õÇ2²örÂ""¢çG&–Ò‚¢ç6Æ–6RƒÂ#’ÇÀ¢&FWF–Ç2#° ¢&WGW&â€¢7F÷&vU&Vf—‚°¢°¢Æö6F–öâçF†æÖRÀ¢Æö6F–öâæ†6‚À¢W‡Æ–6—BÀ¢7VÖÖ'’À¢–æFW€¢Òæ¦ö–â‚'Â"¢“°¢Ğ ¢gVæ7F–öâ&W7F÷&R€¢&ö÷BÒFö7VÖVç@¢’°¢&ö÷@¢çVW'•6VÆV7F÷$ÆÂ€¢&FWF–Ç2 ¢¢æf÷$V6‚€¢†FWF–ÂÂ–æFW‚’Óâ°¢6öç7B7FFRĞ¢6W76–öå7F÷&vRævWD—FVÒ€¢FWF–Ä¶W’€¢FWF–ÂÀ¢–æFW€¢¢“° ¢–b‡7FFRÓÓÒ&÷Vâ"’°¢FWF–Âæ÷VâĞ¢G'VS°¢ÒVÇ6R–b€¢7FFRÓÓÒ&6Æ÷6VB ¢’°¢FWF–Âæ÷VâĞ¢fÇ6S°¢Ğ¢Ğ¢“°¢Ğ ¢Fö7VÖVçBæFDWfVçDÆ—7FVæW"€¢'FövvÆR"À¢WfVçBÓâ°¢6öç7BFWF–ÂĞ¢WfVçBçF&vWC° ¢–b€¢FWF–ÃòçFtæÖRÓĞ¢$DUD”Å2 ¢’°¢&WGW&ã°¢Ğ ¢6öç7BFWF–Ç2Ğ¢'&’æg&öÒ€¢Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ€¢&FWF–Ç2 ¢¢“° ¢6W76–öå7F÷&vRç6WD—FVÒ€¢FWF–Ä¶W’€¢FWF–ÂÀ¢ÖF‚æÖ‚€¢À¢FWF–Ç2æ–æFW„öb€¢FWF–À¢¢¢’À¢FWF–Âæ÷Và¢ò&÷Vâ ¢¢&6Æ÷6VB ¢“°¢ÒÀ¢G'VP¢“° ¢æWr×WFF–öäö'6W'fW"€¢&V6÷&G2Óâ°¢f÷"€¢6öç7B&V6÷&Bö`¢&V6÷&G0¢’°¢f÷"€¢6öç7BæöFRö`¢&V6÷&BæFFVDæöFW0¢’°¢–b€¢æöFRææöFUG—RÓÓĞ¢b`¢æöFRçVW'•6VÆV7F÷#òâ€¢&FWF–Ç2 ¢¢’°¢&W7F÷&R€¢æöFP¢“°¢Ğ¢Ğ¢Ğ¢Ğ¢’æö'6W'fR€¢Fö7VÖVçBæFö7VÖVçDVÆVÖVçBÀ¢°¢6†–ÆDÆ—7C¢G'VRÀ¢7V'G&VS¢G'VP¢Ğ¢“° ¢&W7F÷&R‚“°§Ò’‚“°   ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢Tä•dU%4Â5U5DôÔU"DUD”Å25DDRc ¢6fW2öVF—G2÷&W&VæFW'2Fòæ÷B6Æ÷6R÷VâF'2à£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ¢†gVæ7F–öâ6WGW7F&ÆT7W7FöÖW$FWF–Ç57FFR‚’°¢6öç7B&Vf—‚Ğ¢'6ærÖ7W7FöÖW"ÖFWF–Ç2×c#¢#° ¢gVæ7F–öâ¶W’€¢FWF–À¢’°¢6öç7BW‡Æ–6—BĞ¢FWF–Âæ–BÇÀ¢FWF–ÂæFF6W@¢òç&öf–ÆU6Æ÷BÇÀ¢FWF–ÂæFF6W@¢òæÖævVE&öf–ÆRÇÀ¢FWF–ÂæFF6W@¢òæÖævVDÖVÖ&W'6†—ÇÀ¢FWF–ÂæFF6W@¢òæ76–væÖVçD–BÇÀ¢"#° ¢6öç7B&VçBĞ¢FWF–Âç&VçDVÆVÖVç@¢òæ6Æ÷6W7B€¢&FWF–Ç2 ¢“° ¢6öç7B&VçD¶W’Ğ¢&VçCòæ–BÇÀ¢&VçCòæFF6W@¢òç&öf–ÆU6Æ÷BÇÀ¢&VçCòæFF6W@¢òæ76–væÖVçD–BÇÀ¢"#° ¢6öç7B†VF–ærĞ¢FWF–ÂçVW'•6VÆV7F÷"€¢#§66÷Râ7VÖÖ'’ƒÂ§66÷Râ7VÖÖ'’ƒ"Â§66÷Râ7VÖÖ'’ƒ2Â§66÷Râ7VÖÖ'’ƒBÂ§66÷Râ7VÖÖ'’7G&öærÂ§66÷Râ7VÖÖ'’ ¢“òçFW‡D6öçFVç@¢òç&WÆ6R‚õÇ2²örÂ""¢çG&–Ò‚¢ç6Æ–6RƒÂ’ÇÀ¢&FWF–Ç2#° ¢6öç7B6–&Æ–æw2Ğ¢FWF–Âç&VçDVÆVÖVç@¢ò'&’æg&öÒ€¢FWF–Âç&VçDVÆVÖVçBæ6†–ÆG&Và¢’æf–ÇFW"€¢—FVÒÓà¢—FVÒçFtæÖRÓÓĞ¢$DUD”Å2 ¢¢¢µÓ° ¢&WGW&â€¢&Vf—‚°¢°¢Æö6F–öâçF†æÖRÀ¢Æö6F–öâæ†6‚À¢&VçD¶W’À¢W‡Æ–6—BÀ¢†VF–ærÀ¢ÖF‚æÖ‚€¢À¢6–&Æ–æw2æ–æFW„öb€¢FWF–À¢¢¢Òæ¦ö–â‚'Â"¢“°¢Ğ ¢gVæ7F–öâ&W7F÷&R€¢&ö÷BÒFö7VÖVç@¢’°¢6öç7BFWF–Ç2Ğ¢&ö÷BæÖF6†W3òâ‚&FWF–Ç2"¢ò·&ö÷EĞ¢¢'&’æg&öÒ€¢&ö÷BçVW'•6VÆV7F÷$ÆÃòâ€¢&FWF–Ç2 ¢’ÇÀ¢µĞ¢“° ¢f÷"€¢6öç7BFWF–Âö`¢FWF–Ç0¢’°¢6öç7B7FFRĞ¢6W76–öå7F÷&vRævWD—FVÒ€¢¶W’€¢FWF–À¢¢“° ¢–b‡7FFRÓÓÒ&÷Vâ"’°¢FWF–Âæ÷VâĞ¢G'VS°¢ÒVÇ6R–b€¢7FFRÓÓÒ&6Æ÷6VB ¢’°¢FWF–Âæ÷VâĞ¢fÇ6S°¢Ğ¢Ğ¢Ğ ¢Fö7VÖVçBæFDWfVçDÆ—7FVæW"€¢'FövvÆR"À¢WfVçBÓâ°¢6öç7BFWF–ÂĞ¢WfVçBçF&vWC° ¢–b€¢FWF–ÃòçFtæÖRÓĞ¢$DUD”Å2 ¢’°¢&WGW&ã°¢Ğ ¢6W76–öå7F÷&vRç6WD—FVÒ€¢¶W’€¢FWF–À¢’À¢FWF–Âæ÷Và¢ò&÷Vâ ¢¢&6Æ÷6VB ¢“°¢ÒÀ¢G'VP¢“° ¢æWr×WFF–öäö'6W'fW"€¢&V6÷&G2Óâ°¢f÷"€¢6öç7B&V6÷&Bö`¢&V6÷&G0¢’°¢f÷"€¢6öç7BæöFRö`¢&V6÷&BæFFVDæöFW0¢’°¢–b€¢æöFRææöFUG—RÓÓĞ¢¢’°¢&W7F÷&R€¢æöFP¢“°¢Ğ¢Ğ¢Ğ¢Ğ¢’æö'6W'fR€¢Fö7VÖVçBæFö7VÖVçDVÆVÖVçBÀ¢°¢6†–ÆDÆ—7C¢G'VRÀ¢7V'G&VS¢G'VP¢Ğ¢“° ¢&W7F÷&R‚“°§Ò’‚“°   ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞ¢´TU5U5DôÔU"”âD„R4ÔRtRõ4•D”ôâeDU"4dRò5T$Ô•@£ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ¢†gVæ7F–öâ6WGW7W7FöÖW%7F&ÆT7F–öå÷6—F–öâ‚’°¢6öç7B7F÷&vT¶W’Ğ¢6ærÖ7W7FöÖW"Ö7F–öâ×÷6—F–öã¢G¶Æö6F–öâçF†æÖWÒG¶Æö6F–öâæ†6‡Ö° ¢ÆWB6ÆV%F–ÖW"Ğ¢çVÆÃ° ¢gVæ7F–öâ&VÖVÖ&W"‚’°¢6W76–öå7F÷&vRç6WD—FVÒ€¢7F÷&vT¶W’À¢¥4ôâç7G&–æv–g’‡°¢“ ¢v–æF÷rç67&öÆÅ’À ¢C ¢FFRææ÷r‚¢Ò¢“°¢Ğ ¢gVæ7F–öâ&W7F÷&R‚’°¢ÆWB6fVC° ¢G'’°¢6fVBĞ¢¥4ôâç'6R€¢6W76–öå7F÷&vRævWD—FVÒ€¢7F÷&vT¶W¢’ÇÀ¢&çVÆÂ ¢“°¢Ò6F6‚°¢6fVBĞ¢çVÆÃ°¢Ğ ¢–b€¢6fVBÇÀ¢FFRææ÷r‚’Ğ¢çVÖ&W"€¢6fVBæBÇÀ¢ ¢’à¢S ¢’°¢&WGW&ã°¢Ğ ¢&WVW7Dæ–ÖF–öäg&ÖR€¢‚’Óâ°¢v–æF÷rç67&öÆÅFò€¢v–æF÷rç67&öÆÅ‚À¢çVÖ&W"€¢6fVBç’ÇÀ¢ ¢¢“°¢Ğ¢“° ¢6ÆV%F–ÖV÷WB€¢6ÆV%F–ÖW ¢“° ¢6ÆV%F–ÖW"Ğ¢6WEF–ÖV÷WB€¢‚’Óâ°¢6W76–öå7F÷&vRç&VÖ÷fT—FVÒ€¢7F÷&vT¶W¢“°¢ÒÀ¢“ ¢“°¢Ğ ¢Fö7VÖVçBæFDWfVçDÆ—7FVæW"€¢'7V&Ö—B"À¢&VÖVÖ&W"À¢G'VP¢“° ¢Fö7VÖVçBæFDWfVçDÆ—7FVæW"€¢&6Æ–6²"À¢WfVçBÓâ°¢6öç7B'WGFöâĞ¢WfVçBçF&vWBæ6Æ÷6W7B€¢&'WGFöâ ¢“° ¢–b‚'WGFöâ’°¢&WGW&ã°¢Ğ ¢6öç7BÆ&VÂĞ¢7G&–ær€¢'WGFöâçFW‡D6öçFVçBÇÀ¢" ¢¢ç&WÆ6R€¢õÇ2²örÀ¢" ¢¢çG&–Ò‚¢çFõWW$66R‚“° ¢–b€¢õ4dWÅ5T$Ô•GÅUDDWÄDB$ôd”ÄWÄDTÄUDWÅ$TÔõdWÄ5D•dDWÄDT5D•dDWÄU…DTäGÅ$UEU$âDòôôÇÄÄ”ä²U„•5D”äwÄ4Ä”×Ä4ÄT"4%GÄ4„T4´õUGÄ4ôäd•$ÒòçFW7B€¢Æ&VÀ¢¢’°¢&VÖVÖ&W"‚“°¢Ğ¢ÒÀ¢G'VP¢“° ¢v–æF÷ræFDWfVçDÆ—7FVæW"€¢'vW6†÷r"À¢&W7F÷&P¢“° ¢6öç7Bö'6W'fW"Ğ¢æWr×WFF–öäö'6W'fW"€¢‚’Óâ°¢&W7F÷&R‚“°¢Ğ¢“° ¢ö'6W'fW"æö'6W'fR€¢Fö7VÖVçBæ&öG’À¢°¢6†–ÆDÆ—7C ¢G'VRÀ ¢7V'G&VS ¢G'VP¢Ğ¢“°§Ò’‚“° ¢ò¢V&Æ–2vw&VvFR7V66W72F—7Æ“²F†—2&W7öç6RæWfW"–æ6ÇVFW27W7FöÖW"FFâ¢ğ¢òòv—fRV6‚&÷VæFVBÆWGFW"—G2÷vâ6†÷'BÂ6öçF–æVBÖVÇB7–6ÆRâ¶VWF†P¢òò÷&–v–æÂ†VF–ær2—G266W76–&ÆRæÖRv†–ÆRF†Rf—7VÂÆWGFW'2æ–ÖFRà¦6öç7B6öÖ×Væ—G”†VF–ærÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'V&Æ–2×7V66W72×F—FÆR"“°¦–b†6öÖ×Væ—G”†VF–ær’°¢6öÖ×Væ—G”†VF–ærç6WDGG&–'WFR‚&&–ÖÆ&VÂ"Â²ââæ6öÖ×Væ—G”†VF–æræ6†–ÆG&VåÒæÖ‡6V7F–öâÓâ6V7F–öâçFW‡D6öçFVçBçG&–Ò‚’’æ¦ö–â‚""’“°¢6öç7Bf–ÆÆVD†VF–æt–ÖvW2ÒæWrÖ‚“°¢f÷"†6öç7B6V7F–öâöb6öÖ×Væ—G”†VF–æræ6†–ÆG&Vâ’°¢6öç7Bv÷&G2Ò6V7F–öâçFW‡D6öçFVçBçG&–Ò‚’ç7Æ—B‚õÇ2²ò“°¢6V7F–öâç&WÆ6T6†–ÆG&Vâ‚“°¢6V7F–öâç6WDGG&–'WFR‚&&–Ö†–FFVâ"Â'G'VR"“°¢v÷&G2æf÷$V6‚‚‡v÷&BÂv÷&D–æFW‚’Óâ°¢6öç7Bw&W"ÒFö7VÖVçBæ7&VFTVÆVÖVçB‚'7â"“°¢w&W"æ6Æ74æÖRÒ'V&Æ–2×7V66W72×v÷&B#°¢f÷"†6öç7B¶ÆWGFW$–æFW‚Â6†&7FW%Òöb²ââçv÷&EÒæVçG&–W2‚’’°¢6öç7BvÇ—‚ÒFö7VÖVçBæ7&VFTVÆVÖVçB‚'7â"“°¢vÇ—‚æ6Æ74æÖRÒ'V&Æ–2×7V66W72ÖÆWGFW"#°¢vÇ—‚çFW‡D6öçFVçBÒ6†&7FW#°¢6öç7B6öÆ÷'v’Ò6V7F–öâæ6Æ74Æ—7Bæ6öçF–ç2‚'V&Æ–2×7V66W72×F—FÆR×F–Â"’ò&7–â"¢'–æ²#°¢6öç7B–ÖvUF‚Òö–ÖvW2öf–ÆÆVBÖ†VF–æròG¶6öÆ÷'v—ÒÒG¶6†&7FW'Òçæv°¢vÇ—‚ç7G–ÆRç6WE&÷W'G’‚"ÒÖf–ÆÆVBÖÆWGFW"Ö–ÖvR"ÂW&Â‚"G¶–ÖvUF‡Ò"–“°¢–b‚f–ÆÆVD†VF–æt–ÖvW2æ†2†–ÖvUF‚’’f–ÆÆVD†VF–æt–ÖvW2ç6WB†–ÖvUF‚ÂµÒ“°¢f–ÆÆVD†VF–æt–ÖvW2ævWB†–ÖvUF‚’çW6‚†vÇ—‚“°¢–b‚õ´U$$õÒòçFW7B†6†&7FW"’’vÇ—‚æFF6WBæ&Æ6µ‚Ò,9r#°¢6öç7B6VVBÒ‡v÷&D–æFW‚¢r²ÆWGFW$–æFW‚¢#2²6†&7FW"æ6öFUö–çDBƒ’¢r’RCs°¢vÇ—‚ç7G–ÆRç6WE&÷W'G’‚"ÒÖÖVÇBÖFVÆ’"ÂG²Ò‡6VVB¢ãC2’çFôf—†VBƒ"—×6“°¢vÇ—‚ç7G–ÆRç6WE&÷W'G’‚"ÒÖÖVÇBÖGW&F–öâ"ÂG²ƒ"²6VVBRr¢ãSR’çFôf—†VBƒ"—×6“°¢vÇ—‚ç7G–ÆRç6WE&÷W'G’‚"ÒÖÖVÇBÖævÆR"ÂG·6VVBR"ò"¢Ó'ÖFVv“°¢w&W"æVæB†vÇ—‚“°¢Ğ¢6V7F–öâæVæB‡w&W"“°¢Ò“°¢Ğ¢&öÖ—6RæÆÂ…²ââæf–ÆÆVD†VF–æt–ÖvW2æ¶W—2‚•ÒæÖ‡7&2ÓâæWr&öÖ—6R‡&W6öÇfRÓâ°¢6öç7B–ÖvRÒæWr–ÖvR‚“°¢–ÖvRæöæÆöBÒ‚’Óâ°¢f÷"†6öç7BvÇ—‚öbf–ÆÆVD†VF–æt–ÖvW2ævWB‡7&2’’°¢vÇ—‚ç7G–ÆRç6WE&÷W'G’‚"ÒÖf–ÆÆVBÖÆWGFW"×v–GF‚"ÂG²†–ÖvRçv–GF‚ò#’çFôf—†VBƒ2—ÖVÖ“°¢Ğ¢&W6öÇfR‚“°¢Ó°¢–ÖvRæöæW'&÷"Ò&W6öÇfS°¢–ÖvRç7&2Ò7&3°¢Ò’’’çF†Vâ‚‚’Óâ6öÖ×Væ—G”†VF–æræ6Æ74Æ—7BæFB‚&f–ÆÆVBÖ†VF–ær×&VG’"’“°§Ğ ¦6öç7BV&Æ–57V66W757FFRÒ²&öGV7G3¢µÒÂ–æFWƒ¢ÂÆöF–æs¢fÇ6RÂ6†÷våVçF—F–W3¢æWrÖ‚’Ó° ¢ò¢6—FWv–FRFÖ–âææ÷Væ6VÖVçC²F—6Ö—76Ç27W'f—fRvR6†ævW2æB&VÆöG2â¢ğ¦–b†æWrU$Å6V&6…&×2†Æö6F–öâç6V&6‚’ævWB‚'7V66W74FVÖò"’ÓÒ#"’°¢6öç7Bææ÷Væ6VÖVçBÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6—FTææ÷Væ6VÖVçB"“°¢6öç7BF—FÆRÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6—FTææ÷Væ6VÖVçEF—FÆR"“°¢6öç7BÖW76vRÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6—FTææ÷Væ6VÖVçDÖW76vR"“°¢ÆWB7W'&VçDææ÷Væ6VÖVçD–BÒçVÆÃ°¢ÆWBææ÷Væ6VÖVçE&WVW7E'Vææ–ærÒfÇ6S° ¢6öç7BF—6Ö—76VDÆö6ÆÇ’Ò–BÓâ°¢G'’²&WGW&âÆö6Å7F÷&vRævWD—FVÒ†6æuöæ÷F–6UöF—6Ö—76VEòG¶–GÖ’ÓÓÒ##²Ğ¢6F6‚²&WGW&âfÇ6S²Ğ¢Ó° ¢7–æ2gVæ7F–öâ&Vg&W6…6—FTææ÷Væ6VÖVçB‚’°¢–b‚ææ÷Væ6VÖVçBÇÂææ÷Væ6VÖVçE&WVW7E'Vææ–ær’&WGW&ã°¢ææ÷Væ6VÖVçE&WVW7E'Vææ–ærÒG'VS°¢G'’°¢6öç7B&W7öç6RÒv—BfWF6‚‚"ö’÷V&Æ–2öæ÷F–f–6F–öâ"Â°¢7&VFVçF–Ç3¢'6ÖRÖ÷&–v–â"Â66†S¢&æò×7F÷&R ¢Ò“°¢–b‚&W7öç6Ræö²’&WGW&ã°¢6öç7BFFÒv—B&W7öç6Ræ§6öâ‚“°¢6öç7Bæ÷F–6RÒFFææ÷F–f–6F–öã°¢–b‚æ÷F–6Sòæ–BÇÂFFæF—6Ö—76VBÇÂF—6Ö—76VDÆö6ÆÇ’†æ÷F–6Ræ–B’’°¢ææ÷Væ6VÖVçBæ†–FFVâÒG'VS°¢7W'&VçDææ÷Væ6VÖVçD–BÒçVÆÃ°¢&WGW&ã°¢Ğ¢7W'&VçDææ÷Væ6VÖVçD–BÒæ÷F–6Ræ–C°¢F—FÆRçFW‡D6öçFVçBÒæ÷F–6RçF—FÆS°¢ÖW76vRçFW‡D6öçFVçBÒæ÷F–6RæÖW76vS°¢ææ÷Væ6VÖVçBæ†–FFVâÒfÇ6S°¢Ò6F6‚°¢òò¶VWF†R7W'&VçBf—6–&ÆRææ÷Væ6VÖVçBGW&–ærFV×÷&'’÷WFvRà¢Òf–æÆÇ’°¢ææ÷Væ6VÖVçE&WVW7E'Vææ–ærÒfÇ6S°¢Ğ¢Ğ ¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚'6—FTææ÷Væ6VÖVçD6Æ÷6R"“òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ°¢–b‚7W'&VçDææ÷Væ6VÖVçD–B’&WGW&ã°¢6öç7B–BÒ7W'&VçDææ÷Væ6VÖVçD–C°¢ææ÷Væ6VÖVçBæ†–FFVâÒG'VS°¢7W'&VçDææ÷Væ6VÖVçD–BÒçVÆÃ°¢G'’²Æö6Å7F÷&vRç6WD—FVÒ†6æuöæ÷F–6UöF—6Ö—76VEòG¶–GÖÂ#"“²Ğ¢6F6‚²ò¢7F÷&vR6â&RF—6&ÆVB–â&—fFR'&÷w6–ærâ¢òĞ¢–b‡7FFRæ7W7FöÖW"’°¢fWF6‚†ö’ö66÷VçB÷6—FRÖæ÷F–f–6F–öâòG¶Væ6öFUU$”6ö×öæVçB†–B—ÒöF—6Ö—76Â°¢ÖWF†öC¢%õ5B"Â7&VFVçF–Ç3¢'6ÖRÖ÷&–v–â ¢Ò’æ6F6‚‚‚’Óâ·Ò“°¢Ğ¢Ò“° ¢&Vg&W6…6—FTææ÷Væ6VÖVçB‚“°¢–b‡G—VöbWfVçE6÷W&6RÓÒ'VæFVf–æVB"’°¢6öç7BWFFW2ÒæWrWfVçE6÷W&6R‚"ö’÷V&Æ–2öæ÷F–f–6F–öâöWfVçG2"“°¢WFFW2æFDWfVçDÆ—7FVæW"‚&æ÷F–f–6F–öâ"Â&Vg&W6…6—FTææ÷Væ6VÖVçB“°¢Ğ¢6WD–çFW'fÂ‚‚’Óâ²–b‚Fö7VÖVçBæ†–FFVâ’&Vg&W6…6—FTææ÷Væ6VÖVçB‚“²ÒÂ#“°¢Fö7VÖVçBæFDWfVçDÆ—7FVæW"‚'f—6–&–Æ—G–6†ævR"Â‚’Óâ°¢–b‚Fö7VÖVçBæ†–FFVâ’&Vg&W6…6—FTææ÷Væ6VÖVçB‚“°¢Ò“°§Ğ ¦gVæ7F–öâ&VæFW%V&Æ–57V66W75&öGV7B‚’°¢6öç7B²&öGV7G2ÒÒV&Æ–57V66W757FFS°¢6öç7B&öGV7BÒ&öGV7G5·V&Æ–57V66W757FFRæ–æFW…Ó°¢6öç7B6öçF–æW"ÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'V&Æ–2×7V66W72×&öGV7B"“°¢–b‚6öçF–æW"’&WGW&ã° ¢6öçF–æW"ç&WÆ6T6†–ÆG&Vâ‚“°¢–b‡&öGV7B’°¢6öç7B–ÖvUw&ÒFö7VÖVçBæ7&VFTVÆVÖVçB‚&F—b"“°¢–ÖvUw&æ6Æ74æÖRÒ'V&Æ–2×7V66W72Ö–ÖvR#°¢–b‡&öGV7Bæ–ÖvUW&Âbbõæ‡GG3¥ÂõÂòö’çFW7B‡&öGV7Bæ–ÖvUW&Â’’°¢6öç7B–ÖrÒFö7VÖVçBæ7&VFTVÆVÖVçB‚&–Ör"“°¢–Örç7&2Ò&öGV7Bæ–ÖvUW&Ã°¢–ÖræÇBÒ"#°¢–ÖræÆöF–ærÒ&Æ§’#°¢–Örç&VfW'&W%öÆ–7’Ò&æò×&VfW'&W"#°¢–ÖræöæW'&÷"Ò‚’Óâ²–ÖvUw&çFW‡D6öçFVçBÒ$–ÖvRVæf–Æ&ÆR#²Ó°¢–ÖvUw&æVæB†–Ör“°¢ÒVÇ6R°¢–ÖvUw&çFW‡D6öçFVçBÒ$–ÖvRVæf–Æ&ÆR#°¢Ğ¢6öç7BæÖRÒFö7VÖVçBæ7&VFTVÆVÖVçB‚'7G&öær"“°¢æÖRçFW‡D6öçFVçBÒ&öGV7BææÖS°¢6öç7B6÷VçBÒFö7VÖVçBæ7&VFTVÆVÖVçB‚'7â"“°¢6÷VçBæVæB†Fö7VÖVçBæ7&VFUFW‡DæöFR‚,9r"’“°¢6öç7BVçF—G’ÒFö7VÖVçBæ7&VFTVÆVÖVçB‚&""“°¢VçF—G’æ–BÒ'V&Æ–2×7V66W72×&öGV7B×VçF—G’#°¢6öç7B&Wf–÷W5VçF—G’ÒV&Æ–57V66W757FFRç6†÷våVçF—F–W2ævWB‡&öGV7BææÖR“°¢–b‡&Wf–÷W5VçF—G’ÓÒVæFVf–æVB’°¢VçF—G’çFW‡D6öçFVçBÒf÷&ÖE7V66W74çVÖ&W"‡&Wf–÷W5VçF—G’“°¢VçF—G’æFF6WBç7V66W74ÖWG&–5fÇVRÒ7G&–ær‡&Wf–÷W5VçF—G’“°¢VçF—G’æFF6WBç7V66W74ÖWG&–47W'&Væ7’Ò&fÇ6R#°¢VçF—G’æFF6WBç7V66W74ÖWG&–5FW‡BÒVçF—G’çFW‡D6öçFVçC°¢Ğ¢6÷VçBæVæB‡VçF—G’“°¢6öçF–æW"æVæB†–ÖvUw&ÂæÖRÂ6÷VçB“°¢&öÆÅ7V66W74ÖWG&–2‚'V&Æ–2×7V66W72×&öGV7B×VçF—G’"Â&öGV7BçVçF—G’“°¢V&Æ–57V66W757FFRç6†÷våVçF—F–W2ç6WB‡&öGV7BææÖRÂ&öGV7BçVçF—G’“°¢ÒVÇ6R°¢6öçF–æW"çFW‡D6öçFVçBÒ%W&6†6VB&öGV7G2v–ÆÂV"†W&RgFW"6†V6¶÷WBFF—2FWFV7FVBâ#°¢Ğ¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚'V&Æ–2×7V66W72×÷6—F–öâ"’çFW‡D6öçFVçBÒ&öGV7G2æÆVæwF€¢òG·V&Æ–57V66W757FFRæ–æFW‚²ÒöbG·&öGV7G2æÆVæwF‡Ö¢#öb#°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚'V&Æ–2×7V66W72×&Wf–÷W2"’æF—6&ÆVBÒV&Æ–57V66W757FFRæ–æFW‚ÓÓÒ°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚'V&Æ–2×7V66W72ÖæW‡B"’æF—6&ÆVBÒV&Æ–57V66W757FFRæ–æFW‚ãÒ&öGV7G2æÆVæwF‚Ò°§Ğ ¦7–æ2gVæ7F–öâ&Vg&W6…V&Æ–57V66W72‚’°¢–b‡V&Æ–57V66W757FFRæÆöF–ærÇÂFö7VÖVçBævWDVÆVÖVçD'”–B‚'V&Æ–2×7V66W72Ö6†V6¶÷WG2"’’&WGW&ã°¢V&Æ–57V66W757FFRæÆöF–ærÒG'VS°¢G'’°¢6öç7B&W7öç6RÒv—BfWF6‚‚"ö’÷V&Æ–2÷7V66W72"Â²66†S¢&æò×7F÷&R"Ò“°¢–b‚&W7öç6Ræö²’F‡&÷ræWrW'&÷"‚%F÷FÇ2Væf–Æ&ÆR"“°¢6öç7BFFÒv—B&W7öç6Ræ§6öâ‚“°¢&öÆÅ7V66W74ÖWG&–2‚'V&Æ–2×7V66W72Ö6†V6¶÷WG2"ÂFFçF÷FÄ6†V6¶÷WG2“°¢&öÆÅ7V66W74ÖWG&–2‚'V&Æ–2×7V66W72×7VçB"ÂFFçF÷FÅ7VçBÂG'VR“°¢V&Æ–57V66W757FFRç&öGV7G2Ò'&’æ—4'&’†FFç&öGV7G2’òFFç&öGV7G2¢µÓ°¢V&Æ–57V66W757FFRæ–æFW‚ÒÖF‚æÖ–â‡V&Æ–57V66W757FFRæ–æFW‚ÂÖF‚æÖ‚ƒÂV&Æ–57V66W757FFRç&öGV7G2æÆVæwF‚Ò’“°¢&VæFW%V&Æ–57V66W75&öGV7B‚“°¢Ò6F6‚°¢–b†Fö7VÖVçBævWDVÆVÖVçD'”–B‚'V&Æ–2×7V66W72Ö6†V6¶÷WG2"’çFW‡D6öçFVçBÓÓÒ.(	B"’°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚'V&Æ–2×7V66W72×&öGV7B"’çFW‡D6öçFVçBÒ$6öÖ×Væ—G’F÷FÇ2&RFV×÷&&–Ç’Væf–Æ&ÆRâ#°¢Ğ¢Òf–æÆÇ’°¢V&Æ–57V66W757FFRæÆöF–ærÒfÇ6S°¢Ğ§Ğ ¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚'V&Æ–2×7V66W72×&Wf–÷W2"“òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ°¢V&Æ–57V66W757FFRæ–æFW‚ÒÖF‚æÖ‚ƒÂV&Æ–57V66W757FFRæ–æFW‚Ò“°¢&VæFW%V&Æ–57V66W75&öGV7B‚“°§Ò“°¦Fö7VÖVçBævWDVÆVÖVçD'”–B‚'V&Æ–2×7V66W72ÖæW‡B"“òæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ°¢V&Æ–57V66W757FFRæ–æFW‚ÒÖF‚æÖ–â‡V&Æ–57V66W757FFRç&öGV7G2æÆVæwF‚ÒÂV&Æ–57V66W757FFRæ–æFW‚²“°¢&VæFW%V&Æ–57V66W75&öGV7B‚“°§Ò“°§&Vg&W6…V&Æ–57V66W72‚“°§6WD–çFW'fÂ‚‚’Óâ°¢–b†Fö7VÖVçBçf—6–&–Æ—G•7FFRÓÓÒ'f—6–&ÆR"’&Vg&W6…V&Æ–57V66W72‚“°§ÒÂCR¢“° ¦–b‚5T44U55ôDTÔõôÔôDRbbG—VöbWfVçE6÷W&6RÓÒ'VæFVf–æVB"’°¢6öç7BV&Æ–4WfVçG2ÒæWrWfVçE6÷W&6R‚"ö’÷V&Æ–2÷7V66W72öWfVçG2"“°¢V&Æ–4WfVçG2æFDWfVçDÆ—7FVæW"‚&6†V6¶÷WB"Â&Vg&W6…V&Æ–57V66W72“°§Ğ ¦ÆWB7W7FöÖW%7V66W74WfVçG2ÒçVÆÃ°¦gVæ7F–öâWFFT7W7FöÖW%7V66W74WfVçG2‚’°¢6öç7BæVÂÒFö7VÖVçBævWDVÆVÖVçD'”–B‚&66÷VçB×F"×7V66W72"“°¢6öç7Bf—6–&ÆRÒ5T44U55ôDTÔõôÔôDRbbFö7VÖVçBçf—6–&–Æ—G•7FFRÓÓÒ'f—6–&ÆR"b`¢æVÂbbæVÂæ†–FFVâbbFö7VÖVçBævWDVÆVÖVçD'”–B‚&×’×&öf–ÆR"“òæ6Æ74Æ—7Bæ6öçF–ç2‚&7F—fR"“°¢–b‚f—6–&ÆRbb7W7FöÖW%7V66W74WfVçG2’°¢7W7FöÖW%7V66W74WfVçG2æ6Æ÷6R‚“°¢7W7FöÖW%7V66W74WfVçG2ÒçVÆÃ°¢ÒVÇ6R–b‡f—6–&ÆRbb7W7FöÖW%7V66W74WfVçG2bbG—VöbWfVçE6÷W&6RÓÒ'VæFVf–æVB"’°¢7W7FöÖW%7V66W74WfVçG2ÒæWrWfVçE6÷W&6R‚"ö’ö66÷VçB÷7V66W72öWfVçG2"“°¢7W7FöÖW%7V66W74WfVçG2æFDWfVçDÆ—7FVæW"‚&6†V6¶÷WB"Â‚’ÓâÆöE7V66W74F6†&ö&B‡G'VR’“°¢Ğ§Ğ ¦Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ‚%¶FFÖ66÷VçB×F%Ò"’æf÷$V6‚†'WGFöâÓâ°¢'WGFöâæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ6WEF–ÖV÷WB‡WFFT7W7FöÖW%7V66W74WfVçG2Â’“°§Ò“°¦Fö7VÖVçBçVW'•6VÆV7F÷$ÆÂ‚%¶FF×vUÒ"’æf÷$V6‚†'WGFöâÓâ°¢'WGFöâæFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâ6WEF–ÖV÷WB‡WFFT7W7FöÖW%7V66W74WfVçG2Â’“°§Ò“°¦Fö7VÖVçBæFDWfVçDÆ—7FVæW"‚'f—6–&–Æ—G–6†ævR"Â‚’Óâ°¢WFFT7W7FöÖW%7V66W74WfVçG2‚“°¢–b†Fö7VÖVçBçf—6–&–Æ—G•7FFRÓÓÒ'f—6–&ÆR"’°¢&Vg&W6…V&Æ–57V66W72‚“°¢–b†7W7FöÖW%7V66W74WfVçG2’ÆöE7V66W74F6†&ö&B‡G'VR“°¢Ğ§Ò“° ¦gVæ7F–öâ†öÖWvU6×ÆU7V66W74FF‚’°¢6öç7B6÷VçG2Ò³ÂÂÂ"ÂÂÂ2ÂÂÂ"Â"ÂÂ2Â%Ó°¢6öç7B&öGV7G2Ò°¢²æÖS¢%ö¼:–ÖöâÆFVâfFW2&ö÷7FW"'VæFÆR"Â–ÖvUW&Ã¢&‡GG3¢ò÷wwrçö¶VÖöâæ6öÒ÷7FF–2Ö76WG2ö6öçFVçBÖ76WG2ö6×3"ö–Ör÷G&F–ærÖ6&BÖvÖR÷6W&–W2ö–æ7&VÖVçFÇ2ó##B÷7cCRÖ&ö÷7FW"Ö'VæFÆR÷7cCRÖ&ö÷7FW"Ö'VæFÆRÓc’ÖVâçær"ÒÀ¢²æÖS¢$F—6æW’Æ÷&6æF†Rf—'7B6†FW"7F'FW"FV6²"Â–ÖvUW&Ã¢&‡GG3¢ò÷&fVç6'W&vW"æ6Æ÷VBö6×2övÆÆW'’÷3×7F'FW"ÖFV6·2çær"ÒÀ¢²æÖS¢$Öv–3¢F†RvF†W&–ærVFvRöbWFW&æ—F–W2'VæFÆR"Â–ÖvUW&Ã¢&‡GG3¢òö–ÖvW2æ7Ff76WG2ææWB÷3Vã'Cs—––7ó#„wW—#†DÖ3TÖƒ$%U6¢ó“VS“#FSvc&#S†C&&S3ƒc–6#v6#V#2ôTôRÓ5ôä¤4¤4¤„Eô'VæFÆUôTâçær"Ğ¢Ó°¢6öç7B&WF–ÆW'2Ò²%F&vWB"Â%vÆÖ'B"Â$6÷7F6ò%Ó°¢6öç7B÷&FW'2ÒµÓ°¢6öç7B7F—f—G’ÒµÓ°¢6öç7B&ævRÒvWE7V66W75&ævR‚“°¢6öç7BF’ÒæWrFFR†G·&ævRç7F'GÕC#££“°¢6öç7BFöF’Ò7V66W74FFT–çWEfÇVR†æWrFFR‚’“°¢ÆWB6W&–ÂÒ° ¢f÷"†ÆWB–æFW‚Ò²–æFW‚ÂC²–æFW‚³Ò’°¢6öç7BFFRÒ7V66W74FFT–çWEfÇVR†F’“°¢6öç7B6÷VçBÒFFRÃÒFöF’ò6÷VçG5¶–æFW…Ò¢°¢ÆWBfÇVRÒ°¢f÷"†ÆWBâÒ²âÂ6÷VçC²â³Ò’°¢6W&–Â³Ò°¢6öç7BVçF—G’Ò²‡6W&–ÂR2“°¢6öç7BF÷FÂÒC’ã“’²VçF—G’¢#Bã““°¢fÇVR³ÒF÷FÃ°¢÷&FW'2çW6‚‡°¢–C¢4ÕÄRÒG·6W&–ÇÖÀ¢&WF–ÆW#¢&WF–ÆW'5·6W&–ÂR&WF–ÆW'2æÆVæwF…ÒÀ¢÷&FW$çVÖ&W#¢4ÕÄRÒG³²6W&–ÇÖÀ¢&öf–ÆTæÖS¢&öf–ÆRG³²6W&–ÂR'ÖÀ¢6†V6¶÷WDC¢G¶FFWÕCc££ã¦À¢—FVÔ6÷VçC¢VçF—G’À¢÷&FW%F÷FÃ¢F÷FÂÀ¢—FV×3¢·²ââç&öGV7G5·6W&–ÂR&öGV7G2æÆVæwF…ÒÂVçF—G’ÕĞ¢Ò“°¢Ğ¢7F—f—G’çW6‚‡²FFRÂ6÷VçBÂfÇVRÒ“°¢F’ç6WDFFR†F’ævWDFFR‚’²“°¢Ğ ¢6öç7BF÷FÂÒ÷&FW'2ç&VGV6R‚‡7VÒÂ÷&FW"’Óâ7VÒ²÷&FW"æ÷&FW%F÷FÂÂ“°¢&WGW&â°¢ö³¢G'VRÀ¢7–æ3¢²7FGW3¢%&Wf–Wr6öææV7FVB"ÂÆ7E7–æ6VDC¢æWrFFR‚’çFô•4õ7G&–ær‚’ÒÀ¢7VÖÖ'“¢°¢F÷FÄ6†V6¶÷WG3¢÷&FW'2æÆVæwF‚À¢F÷FÄ—FV×3¢÷&FW'2ç&VGV6R‚‡7VÒÂ÷&FW"’Óâ7VÒ²÷&FW"æ—FVÔ6÷VçBÂ’À¢6†V6¶÷WEfÇVS¢F÷FÂÀ¢&W7DF“¢ÖF‚æÖ‚‚ââæ7F—f—G’æÖ†—FVÒÓâ—FVÒæ6÷VçB’¢ÒÀ¢7F—f—G’À¢&V6VçD6†V6¶÷WG3¢÷&FW'2ç&WfW'6R‚¢Ó°§Ğ ¦6öç7B6—FT&6µFõF÷ÒFö7VÖVçBævWDVÆVÖVçD'”–B‚'6—FT&6µFõF÷"“°¦–b‡6—FT&6µFõF÷’°¢6öç7BWFFT&6µFõF÷Ò‚’Óâ²6—FT&6µFõF÷æ†–FFVâÒv–æF÷rç67&öÆÅ’ÂC#²Ó°¢v–æF÷ræFDWfVçDÆ—7FVæW"‚'67&öÆÂ"ÂWFFT&6µFõF÷Â²76—fS¢G'VRÒ“°¢6—FT&6µFõF÷æFDWfVçDÆ—7FVæW"‚&6Æ–6²"Â‚’Óâv–æF÷rç67&öÆÅFò‡²F÷¢Â&V†f–÷#¢'6Öö÷F‚"Ò’“°¢WFFT&6µFõF÷‚“°§Ğ ¦–b…5T44U55ôDTÔõôÔôDR’°¢6öç7BæVÂÒFö7VÖVçBævWDVÆVÖVçD'”–B‚&66÷VçB×F"×7V66W72"“°¢6öç7Bw&W"ÒFö7VÖVçBæ7&VFTVÆVÖVçB‚&Ö–â"“°¢w&W"æ–BÒ&×’×&öf–ÆR#°¢w&W"æ6Æ74æÖRÒ'vR7F—fR7V66W72ÖFVÖòÖöæÇ’#°¢æVÂæ†–FFVâÒfÇ6S°¢æVÂæ6Æ74Æ—7BæFB‚&7F—fR"“°¢w&W"æVæB‡æVÂ“°¢Fö7VÖVçBæ&öG’ç&WÆ6T6†–ÆG&Vâ‡w&W"“°¢Fö7VÖVçBæ&öG’æ6Æ74Æ—7BæFB‚'7V66W72ÖFVÖòÖ&öG’"“°¢Fö7VÖVçBæFö7VÖVçDVÆVÖVçBæ6Æ74Æ—7Bç&VÖ÷fR‚'7V66W72ÖFVÖòÖÆöF–ær"“°¢ÆöE7V66W74F6†&ö&B‡G'VR“°¢6öç7B&W6—¦RÒ‚’Óâ&VçBç÷7DÖW76vR‡²G—S¢'6ær×7V66W72ÖFVÖòÖ†V–v‡B"Â†V–v‡C¢ÖF‚æ6V–Â‡w&W"ævWD&÷VæF–æt6Æ–VçE&V7B‚’æ†V–v‡B’²bÒÂÆö6F–öâæ÷&–v–â“°¢æWr&W6—¦Tö'6W'fW"‡&W6—¦R’æö'6W'fR‡w&W"“°¢&W6—¦R‚“°§ÒVÇ6R°¢v–æF÷ræFDWfVçDÆ—7FVæW"‚&ÖW76vR"ÂWfVçBÓâ°¢–b†WfVçBæ÷&–v–âÓÒÆö6F–öâæ÷&–v–âÇÂWfVçBæFFòçG—RÓÒ'6ær×7V66W72ÖFVÖòÖ†V–v‡B"’&WGW&ã°¢6öç7B–g&ÖRÒFö7VÖVçBævWDVÆVÖVçD'”–B‚&†öÖR×7V66W72Ö–g&ÖR"“°¢–b†–g&ÖRbbWfVçBç6÷W&6RÓÓÒ–g&ÖRæ6öçFVçEv–æF÷r’°¢6öç7B†V–v‡BÒçVÖ&W"†WfVçBæFFæ†V–v‡B“°¢–b„çVÖ&W"æ—4f–æ—FR††V–v‡B’bb†V–v‡Bâ’–g&ÖRç7G–ÆRæ†V–v‡BÒG´ÖF‚æÖ‚ƒCÂÖF‚æ6V–Â††V–v‡B’—×†°¢–g&ÖRæ6Æ74Æ—7BæFB‚&—2×&VG’"“°¢Ğ¢Ò“°§Ğ