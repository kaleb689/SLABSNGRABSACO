const PLANS = {
  1: { name: "Starter", profiles: 1, amount: 30 },
  2: { name: "Popular", profiles: 2, amount: 50 },
  3: { name: "Advanced", profiles: 3, amount: 80 },
  4: { name: "Pro", profiles: 5, amount: 130 },
  5: { name: "High Volume", profiles: 10, amount: 215 },
  6: { name: "Power User", profiles: 20, amount: 300 },
  7: { name: "Elite", profiles: 50, amount: 650 }
};

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

retailerAllowance: 0,

retailerProfilesLoaded: false


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
  if (!value) return "—";

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
  if (!value) return "—";

  const end = new Date(value);

  if (Number.isNaN(end.getTime())) {
    return "—";
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
  busyText = "Working…"
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
        tierNumber === 2;

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
   * Popular
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


/* =====================================================
   SELECTED PLAN
===================================================== */

function updateSelectedPlan() {
  const selected =
    document.getElementById(
      "selected-plan"
    );

  if (!selected) return;

  if (
    !state.tier ||
    !PLANS[state.tier]
  ) {
    selected.textContent =
      "Choose a membership first";

    return;
  }

  const plan =
    PLANS[state.tier];

  selected.textContent =
    `${plan.name} — $${plan.amount}/month`;
}


/* =====================================================
   CART
===================================================== */
function clearSelectedTier() {

  state.tier = null;

  localStorage.removeItem(
    "sng_selected_tier"
  );

  updateSelectedPlan();
  updateCart();
}

function updateCart() {
  const count =
    document.getElementById(
      "cart-count"
    );

  const content =
    document.getElementById(
      "cart-content"
    );

  const clearButton =
    document.getElementById(
      "clear-cart"
    );

  const plan =
    state.tier
      ? PLANS[state.tier]
      : null;

  if (!plan) {
    if (count) {
      count.textContent = "0";
    }

    if (clearButton) {
      clearButton.hidden = true;
    }

    if (content) {
      content.innerHTML = `
        <div class="empty-cart">

          <p>
            Your cart is empty.
          </p>

          <button
            type="button"
            class="primary full"
            id="empty-cart-pricing"
          >
            View Memberships
          </button>

        </div>
      `;

      document
        .getElementById(
          "empty-cart-pricing"
        )
        ?.addEventListener(
          "click",
          () => {
            closeCart();
            go("pricing");
          }
        );
    }

    return;
  }

  if (count) {
    count.textContent = "1";
  }

  if (clearButton) {
    clearButton.hidden = false;
  }

  if (content) {
    content.innerHTML = `
      <div class="cart-item">

        <span class="plan-name">
          ${escapeHtml(plan.name)}
        </span>

        <strong>
          $${plan.amount}/month
        </strong>

        <p>
          ${plan.profiles}
          ${
            plan.profiles === 1
              ? "ACO profile"
              : "ACO profiles"
          }
          per supported retailer.
        </p>

      </div>

      <button
        type="button"
        class="primary full"
        id="cart-checkout"
      >
        Get Started →
      </button>
    `;

    document
      .getElementById(
        "cart-checkout"
      )
      ?.addEventListener(
        "click",
        () => {
          closeCart();
          go("profile");
        }
      );
  }
}


function openCart() {
  const drawer =
    document.getElementById(
      "cart-drawer"
    );

  const backdrop =
    document.getElementById(
      "cart-backdrop"
    );

  if (!drawer || !backdrop) {
    return;
  }

  drawer.classList.add("open");
  backdrop.classList.add("open");

  drawer.setAttribute(
    "aria-hidden",
    "false"
  );
}


function closeCart() {
  const drawer =
    document.getElementById(
      "cart-drawer"
    );

  const backdrop =
    document.getElementById(
      "cart-backdrop"
    );

  if (!drawer || !backdrop) {
    return;
  }

  drawer.classList.remove("open");
  backdrop.classList.remove("open");

  drawer.setAttribute(
    "aria-hidden",
    "true"
  );
}


document
  .getElementById("cart-button")
  ?.addEventListener(
    "click",
    openCart
  );


document
  .getElementById("cart-close")
  ?.addEventListener(
    "click",
    closeCart
  );


document
  .getElementById(
    "cart-backdrop"
  )
  ?.addEventListener(
    "click",
    closeCart
  );


document
  .getElementById(
    "cart-view-tiers"
  )
  ?.addEventListener(
    "click",
    () => {
      closeCart();
      go("pricing");
    }
  );


document
  .getElementById(
    "clear-cart"
  )
  ?.addEventListener(
    "click",
    () => {
      clearSelectedTier();
    }
  );


/* =====================================================
   GET STARTED FORM
===================================================== */

const profileForm =
  document.getElementById(
    "profile-form"
  );


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
        "Preparing secure Stripe checkout…";
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
   PAYMENT RETURN / ACCOUNT LINK TOKENS
===================================================== */

const params =
  new URLSearchParams(
    location.search
  );


const paymentStatus =
  params.get("payment");

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
   CUSTOMER ACCOUNT UI
===================================================== */

const accountAuth =
  document.getElementById(
    "account-auth"
  );

const customerDashboard =
  document.getElementById(
    "customer-dashboard"
  );

const loginPanel =
  document.getElementById(
    "login-panel"
  );

const registerPanel =
  document.getElementById(
    "register-panel"
  );

const forgotPasswordPanel =
  document.getElementById(
    "forgot-password-panel"
  );

const passwordResetPanel =
  document.getElementById(
    "password-reset-panel"
  );


function showSignedOut() {
  state.customer = null;
state.membership = null;
state.upgradeMode = false;
state.orders = [];
state.profileLoaded = true;

updatePricingUpgradeButtons();

  if (accountAuth) {
    accountAuth.hidden = false;
  }

  if (customerDashboard) {
    customerDashboard.hidden = true;
  }

  if (loginPanel) {
    loginPanel.hidden = false;
  }

  if (registerPanel) {
    registerPanel.hidden = false;
  }

  if (forgotPasswordPanel) {
    forgotPasswordPanel.hidden = true;
  }

  if (passwordResetPanel) {
    passwordResetPanel.hidden = true;
  }
}


function showSignedIn() {
  if (accountAuth) {
    accountAuth.hidden = true;
  }

  if (customerDashboard) {
    customerDashboard.hidden = false;
  }
}


function showForgotPassword() {
  clearAccountMessage();

  if (loginPanel) {
    loginPanel.hidden = true;
  }

  if (registerPanel) {
    registerPanel.hidden = true;
  }

  if (forgotPasswordPanel) {
    forgotPasswordPanel.hidden = false;
  }

  if (passwordResetPanel) {
    passwordResetPanel.hidden = true;
  }
}


function showNormalAuth() {
  clearAccountMessage();

  if (loginPanel) {
    loginPanel.hidden = false;
  }

  if (registerPanel) {
    registerPanel.hidden = false;
  }

  if (forgotPasswordPanel) {
    forgotPasswordPanel.hidden = true;
  }

  if (passwordResetPanel) {
    passwordResetPanel.hidden = true;
  }
}


function showPasswordReset() {
  if (accountAuth) {
    accountAuth.hidden = false;
  }

  if (customerDashboard) {
    customerDashboard.hidden = true;
  }

  if (loginPanel) {
    loginPanel.hidden = true;
  }

  if (registerPanel) {
    registerPanel.hidden = true;
  }

  if (forgotPasswordPanel) {
    forgotPasswordPanel.hidden = true;
  }

  if (passwordResetPanel) {
    passwordResetPanel.hidden = false;
  }

  go("my-profile");
}


document
  .getElementById(
    "show-forgot-password"
  )
  ?.addEventListener(
    "click",
    showForgotPassword
  );


document
  .getElementById(
    "back-to-login"
  )
  ?.addEventListener(
    "click",
    showNormalAuth
  );


/* =====================================================
   REGISTER
===================================================== */

const registerForm =
  document.getElementById(
    "register-form"
  );


registerForm?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    clearAccountMessage();

    const form =
      event.currentTarget;

    const button =
      form.querySelector(
        'button[type="submit"]'
      );

    const data =
      Object.fromEntries(
        new FormData(form).entries()
      );

    if (
      data.password !==
      data.confirmPassword
    ) {
      showAccountMessage(
        "Your passwords do not match.",
        "error"
      );

      return;
    }

    if (
      String(
        data.password || ""
      ).length < 10
    ) {
      showAccountMessage(
        "Your password must be at least 10 characters.",
        "error"
      );

      return;
    }

    try {
      setButtonBusy(
        button,
        true,
        "Creating Account…"
      );

      const response =
        await fetch(
          "/api/account/register",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            credentials:
              "same-origin",

            body: JSON.stringify({
              email:
                String(
                  data.email || ""
                ).trim(),

              password:
                data.password
            })
          }
        );

      const result =
        await readJson(response);

      if (!response.ok) {
        throw new Error(
          result.error ||
          "Account could not be created."
        );
      }

      form.reset();

      showAccountMessage(
        result.message ||
        "Your account was created. Check your email for the verification link.",
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

    } finally {
      setButtonBusy(
        button,
        false
      );
    }
  }
);


/* =====================================================
   LOGIN
===================================================== */

const loginForm =
  document.getElementById(
    "login-form"
  );


loginForm?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    clearAccountMessage();

    const form =
      event.currentTarget;

    const button =
      form.querySelector(
        'button[type="submit"]'
      );

    const data =
      Object.fromEntries(
        new FormData(form).entries()
      );

    try {
      setButtonBusy(
        button,
        true,
        "Signing In…"
      );

      const response =
        await fetch(
          "/api/account/login",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            credentials:
              "same-origin",

            body: JSON.stringify({
              email:
                String(
                  data.email || ""
                ).trim(),

              password:
                data.password
            })
          }
        );

      const result =
        await readJson(response);

      if (!response.ok) {
        throw new Error(
          result.error ||
          "Unable to sign in."
        );
      }

      form.reset();

      showAccountMessage(
        result.message ||
        "Signed in successfully.",
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

    } finally {
      setButtonBusy(
        button,
        false
      );
    }
  }
);


/* =====================================================
   LOGOUT
===================================================== */

document
  .getElementById(
    "customer-logout"
  )
  ?.addEventListener(
    "click",
    async () => {
      clearAccountMessage();

      try {
        const response =
          await fetch(
            "/api/account/logout",
            {
              method: "POST",

              credentials:
                "same-origin"
            }
          );

        if (!response.ok) {
          const result =
            await readJson(response);

          throw new Error(
            result.error ||
            "Unable to log out."
          );
        }

        showSignedOut();

        showAccountMessage(
          "You have been logged out.",
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
   FORGOT PASSWORD
===================================================== */

const forgotPasswordForm =
  document.getElementById(
    "forgot-password-form"
  );


forgotPasswordForm
  ?.addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      clearAccountMessage();

      const form =
        event.currentTarget;

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

      try {
        setButtonBusy(
          button,
          true,
          "Sending…"
        );

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
                  email:
                    String(
                      data.email ||
                      ""
                    ).trim()
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

        form.reset();

        showAccountMessage(
          result.message ||
          "If an account exists for that email, a password reset link has been sent.",
          "success"
        );

      } catch (error) {
        showAccountMessage(
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
   RESET PASSWORD
===================================================== */

const passwordResetForm =
  document.getElementById(
    "password-reset-form"
  );


passwordResetForm
  ?.addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      clearAccountMessage();

      const form =
        event.currentTarget;

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

      if (!resetToken) {
        showAccountMessage(
          "This password reset link is missing its secure token.",
          "error"
        );

        return;
      }

      if (
        data.password !==
        data.confirmPassword
      ) {
        showAccountMessage(
          "Your passwords do not match.",
          "error"
        );

        return;
      }

      if (
        String(
          data.password || ""
        ).length < 10
      ) {
        showAccountMessage(
          "Your password must be at least 10 characters.",
          "error"
        );

        return;
      }

      try {
        setButtonBusy(
          button,
          true,
          "Resetting…"
        );

        const response =
          await fetch(
            "/api/account/reset-password",
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
                  token:
                    resetToken,

                  password:
                    data.password
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
            "Unable to reset your password."
          );
        }

        form.reset();

        history.replaceState(
          null,
          "",
          "/#my-profile"
        );

        showNormalAuth();

        showAccountMessage(
          result.message ||
          "Your password has been reset. You can now sign in.",
          "success"
        );

      } catch (error) {
        showAccountMessage(
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
   EMAIL VERIFICATION
===================================================== */

async function verifyCustomerEmail(
  token
) {
  if (!token) return;

  go("my-profile");

  showAccountMessage(
    "Verifying your email…",
    "info"
  );

  try {
    const response =
      await fetch(
        "/api/account/verify-email",
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
        "Verifying…"
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
    "Verifying your order…",
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
    value ?? "—";
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

  setText(
    "customer-account-email",
    email
  );

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
   MEMBERSHIP RENDERING
===================================================== */

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
        true;

      upgradeButton.textContent =
        "Upgrade Membership";
    }
  }

  if (!membership) {
    setText(
      "membership-plan-name",
      "No active membership"
    );

    setText(
      "membership-status",
      "—"
    );

    setText(
      "membership-price",
      "—"
    );

    setText(
      "membership-profiles",
      "—"
    );

    setText(
      "membership-period-end",
      "—"
    );

    setText(
      "membership-days-remaining",
      "—"
    );

    setText(
      "detail-plan",
      "—"
    );

    setText(
      "detail-status",
      "—"
    );

    setText(
      "detail-price",
      "—"
    );

    setText(
      "detail-profiles",
      "—"
    );

    setText(
      "detail-period-end",
      "—"
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
      : "—";

  const profileText =
    profiles != null
      ? String(profiles)
      : "—";

  const dateText =
    periodEnd
      ? formatDate(periodEnd)
      : "—";

  setText(
    "membership-plan-name",
    planName
  );

  const membershipStatusElement =
  document.getElementById(
    "membership-status"
  );

if (membershipStatusElement) {

  const normalizedMembershipStatus =
    String(
      membership.status || ""
    ).toLowerCase();

  const isActive =
    [
      "active",
      "trialing"
    ].includes(
      normalizedMembershipStatus
    );

  membershipStatusElement.classList.remove(
    "status-green",
    "status-yellow",
    "status-red"
  );

  if (isActive) {

    membershipStatusElement.classList.add(
      daysRemaining <= 7
        ? "status-yellow"
        : "status-green"
    );

    membershipStatusElement.textContent =
      `● ACTIVE — ${daysRemaining} ${
        daysRemaining === 1
          ? "day"
          : "days"
      } left`;

  } else {

    membershipStatusElement.classList.add(
      "status-red"
    );

    membershipStatusElement.textContent =
      `● ${status.toUpperCase()}`;
  }
}

  setText(
    "membership-price",
    priceText
  );

  setText(
    "membership-profiles",
    profileText
  );

  setText(
    "membership-period-end",
    dateText
  );

  setText(
    "membership-days-remaining",
    daysRemaining
  );

  setText(
    "detail-plan",
    planName
  );

  setText(
    "detail-status",
    status
  );

  setText(
    "detail-price",
    priceText
  );

  setText(
    "detail-profiles",
    profileText
  );

  setText(
    "detail-period-end",
    dateText
  );

  const description =
    document.getElementById(
      "membership-description"
    );

  if (description) {
    if (
      membership.cancelAtPeriodEnd
    ) {
      description.textContent =
        periodEnd
          ? `Your membership is scheduled to end on ${formatDate(
              periodEnd
            )}.`
          : "Your membership is scheduled to cancel at the end of the current billing period.";
    } else {
      description.textContent =
        "Your membership information is connected to your SLABS N GRABS ACO customer account.";
    }
  }
}


/* =====================================================
   ORDER HISTORY
===================================================== */

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
                      : "—"
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
                      : "—"
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
                      : "—"
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
                      : "—"
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
      `${orderNumber} — ${
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
        "Saving…"
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
          "Upgrading…"
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
        showAccountMessage(
          "Your active membership could not be identified.",
          "error"
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
        ✓ Password saved
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

  const passwordConfigured =
    Boolean(
      savedRetailer.passwordConfigured
    );

  return `
    <div
      class="retailer-credential-card"
      data-retailer="${escapeHtml(
        retailer.key
      )}"
    >

      <div
        class="retailer-credential-heading"
      >
        <div>
          <h4>
            ${escapeHtml(
              retailer.name
            )}
          </h4>

          <p>
            Enter the login used for this
            retailer account.
          </p>
        </div>

        ${retailerPasswordStatus(
          passwordConfigured
        )}
      </div>

      <div
        class="retailer-credential-fields"
      >

        <label>
          Username / Email

          <input
            type="text"
            name="${escapeHtml(
              retailer.key
            )}Username"
            value="${escapeHtml(
              username
            )}"
            autocomplete="off"
            maxlength="254"
            placeholder="${escapeHtml(
              retailer.name
            )} username or email"
          >
        </label>

        <label>
          ${
            passwordConfigured
              ? "Replace Password"
              : "Password"
          }

          <div
            class="retailer-password-input-wrap"
          >
            <input
              type="password"
              name="${escapeHtml(
                retailer.key
              )}Password"
              autocomplete="new-password"
              maxlength="512"
              placeholder="${
                passwordConfigured
                  ? "Leave blank to keep saved password"
                  : `Enter ${escapeHtml(
                      retailer.name
                    )} password`
              }"
            >

            <button
              type="button"
              class="retailer-password-toggle"
              data-retailer-password-toggle
              aria-label="Show password"
            >
              Show
            </button>
          </div>
        </label>

      </div>

    </div>
  `;
}


function retailerProfileCardHtml(
  slot,
  savedProfile = null
) {
  const profileName =
    savedProfile?.profileName ||
    `Profile ${slot}`;

  const locked =
    slot >
    state.retailerAllowance;

  const retailers =
    savedProfile?.retailers ||
    {};

  return `
    <article
      class="retailer-profile-card ${
        locked
          ? "locked"
          : ""
      }"
      data-retailer-profile="${slot}"
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
            ${slot}
          </span>

          <div>
            <span class="eyebrow">
              ACO PROFILE ${slot}
            </span>

            <h3>
              ${escapeHtml(
                profileName
              )}
            </h3>
          </div>
        </div>

        ${
          locked
            ? `
              <span
                class="retailer-profile-lock"
              >
                Locked
              </span>
            `
            : `
              <span
                class="retailer-profile-active"
              >
                Available
              </span>
            `
        }

      </div>

      ${
        locked
          ? `
            <div
              class="retailer-profile-locked-message"
            >
              <strong>
                This profile is currently locked.
              </strong>

              <p>
                Your current membership allows
                ${state.retailerAllowance}
                ${
                  state.retailerAllowance === 1
                    ? "profile"
                    : "profiles"
                }.
                Upgrade your membership to access
                this profile again. Any previously
                saved information remains stored.
              </p>
            </div>
          `
          : `
            <form
              class="retailer-profile-form"
              data-retailer-profile-form="${slot}"
            >

              <div
                class="retailer-profile-name-field"
              >
                <label>
                  Profile Name

                  <input
                    type="text"
                    name="profileName"
                    value="${escapeHtml(
                      profileName
                    )}"
                    maxlength="80"
                    placeholder="Example: Personal"
                    required
                  >
                </label>

                <p>
                  Give this ACO profile a name
                  you will recognize.
                </p>
              </div>

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
          ● ACTIVE
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

  <div
    class="retailer-profile-save-row"
  >

    <div
      class="account-message retailer-profile-save-message"
      data-special-profile-message="${escapeHtml(
        profileType
      )}"
      hidden
    ></div>

    <button
      type="submit"
      class="primary retailer-profile-save"
    >
      Save ${profileName}
    </button>

  </div>

</form>

    </article>
  `;
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

  const specialCards =
    state.specialProfiles
      .map(
        profile =>
          specialProfileCardHtml(
            profile
          )
      )
      .filter(Boolean);

  container.innerHTML = `
    ${
      specialCards.length
        ? `
            <div class="profile-category-section special-profile-category">
              <div class="profile-category-heading">
                SPECIAL PROFILES
              </div>

              ${specialCards.join("")}
            </div>
          `
        : `
            <div
              class="retailer-profile-placeholder"
            >

              <div
                class="retailer-profile-placeholder-icon"
              >
                🔒
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


  const specialCards =
  state.specialProfiles
    .map(
      profile =>
        specialProfileCardHtml(
          profile
        )
    )
    .filter(Boolean);

container.innerHTML = `
  ${
    cards.length
      ? `
          <div class="profile-category-section">
            <div class="profile-category-heading">
              PAID PROFILES
            </div>

            ${cards.join("")}
          </div>
        `
      : ""
  }

  ${
    specialCards.length
      ? `
          <div class="profile-category-section special-profile-category">
            <div class="profile-category-heading">
              SPECIAL PROFILES
            </div>

            ${specialCards.join("")}
          </div>
        `
      : ""
  }
`;


  bindRetailerPasswordToggles();

  bindRetailerProfileForms();

  bindSpecialProfileForms();


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
          …
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


async function saveRetailerProfile(
  event
) {
  event.preventDefault();

  const form =
    event.currentTarget;

  const slot =
    Number(
      form.dataset
        .retailerProfileForm
    );

  const message =
    document.querySelector(
      `[data-retailer-profile-message="${slot}"]`
    );

  const button =
    form.querySelector(
      'button[type="submit"]'
    );

  if (
    !Number.isInteger(slot) ||
    slot < 1 ||
    slot > 50
  ) {
    setMessage(
      message,
      "Invalid profile slot.",
      "error"
    );

    return;
  }

  if (
    slot >
    state.retailerAllowance
  ) {
    setMessage(
      message,
      "This profile is not available with your current membership.",
      "error"
    );

    return;
  }

  const formData =
    new FormData(form);

  const profileName =
    String(
      formData.get(
        "profileName"
      ) || ""
    ).trim();

  if (!profileName) {
    setMessage(
      message,
      "Enter a profile name.",
      "error"
    );

    return;
  }

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

      /*
        A blank password intentionally tells
        the server to retain the encrypted
        password already on file.
      */

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
      "Saving…"
    );

    setMessage(
      message,
      ""
    );

    const response =
      await fetch(
        `/api/account/retailer-profiles/${slot}`,
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
              profileName,
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
        "Unable to save this profile."
      );
    }

    const savedProfile =
      data.profile || null;

    if (savedProfile) {
      const existingIndex =
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

    renderRetailerProfiles();

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
      "Saving…"
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

  return `${startText} – ${endText}`;
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
    return "—";
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
    value ?? "—";
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
              } — ${formatSuccessCurrency(
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
        ← Previous
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
        Next →
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

        successState.rangeEnd =
          end;

        successState.loaded =
          false;

        await loadSuccessDashboard(
          true
        );
      }
    );
}


/* =====================================================
   SUCCESS — RECENT ORDER CAROUSEL
===================================================== */

let successCheckoutIndex = 0;


function getSuccessCheckoutItems(
  checkout
) {
  if (
    Array.isArray(checkout?.items) &&
    checkout.items.length
  ) {
    return checkout.items;
  }

  const productName =
    checkout?.product ||
    checkout?.productName ||
    checkout?.item ||
    "";

  if (!productName) {
    return [];
  }

  return [
    {
      name: productName,

      quantity:
        Math.max(
          1,
          Number(
            checkout.quantity ??
            checkout.itemCount ??
            1
          ) || 1
        ),

      price:
        Number(
          checkout.price ??
          checkout.itemPrice ??
          0
        ) || 0,

      imageUrl:
        checkout.imageUrl ||
        checkout.productImage ||
        null
    }
  ];
}


function getSuccessItemImage(
  item
) {
  return (
    item?.imageUrl ||
    item?.image ||
    item?.productImage ||
    item?.thumbnail ||
    ""
  );
}


function renderSuccessProductPreview(
  item,
  index
) {
  const name =
    item?.name ||
    item?.productName ||
    `Item ${index + 1}`;

  const image =
    getSuccessItemImage(
      item
    );

  const quantity =
    Math.max(
      1,
      Number(
        item?.quantity ??
        item?.qty ??
        1
      ) || 1
    );

  if (image) {
    return `
      <div
        class="success-product-preview"
        title="${escapeHtml(name)}"
      >
        <div class="success-product-image-wrap">

          <img
            src="${escapeHtml(image)}"
            alt="${escapeHtml(name)}"
            class="success-product-image"
            loading="lazy"
            referrerpolicy="no-referrer"
          />

          ${
            quantity > 1
              ? `
                <span
                  class="success-product-quantity"
                >
                  ×${formatSuccessNumber(
                    quantity
                  )}
                </span>
              `
              : ""
          }

        </div>

        <span class="success-product-preview-name">
          ${escapeHtml(name)}
        </span>
      </div>
    `;
  }

  return `
    <div
      class="success-product-preview"
      title="${escapeHtml(name)}"
    >
      <div
        class="success-product-image-wrap success-product-placeholder"
      >
        <span>
          ITEM
        </span>

        ${
          quantity > 1
            ? `
              <span
                class="success-product-quantity"
              >
                ×${formatSuccessNumber(
                  quantity
                )}
              </span>
            `
            : ""
        }
      </div>

      <span class="success-product-preview-name">
        ${escapeHtml(name)}
      </span>
    </div>
  `;
}


function renderSuccessCheckouts(
  checkouts = []
) {
  const container =
    document.getElementById(
      "success-checkouts"
    );

  if (!container) {
    return;
  }

  if (
    !Array.isArray(checkouts) ||
    checkouts.length === 0
  ) {
    successCheckoutIndex = 0;

    container.innerHTML = `
      <div class="success-empty">

        <strong>
          No successful checkouts yet.
        </strong>

        <p>
          Successful ACO checkouts will
          appear here after they are
          synchronized to your account.
        </p>

      </div>
    `;

    return;
  }


  /*
    Keep the selected order inside the
    available checkout range.
  */
  successCheckoutIndex =
    Math.min(
      Math.max(
        successCheckoutIndex,
        0
      ),
      checkouts.length - 1
    );


  const checkout =
    checkouts[
      successCheckoutIndex
    ];


  const retailer =
    checkout.retailer ||
    checkout.store ||
    "Retailer";


  const orderNumber =
    checkout.orderNumber ||
    checkout.orderId ||
    checkout.id ||
    "";


  const date =
    checkout.checkoutAt ||
    checkout.date ||
    checkout.createdAt ||
    null;


  /*
    IMPORTANT:
    Our normalized Success records use
    itemCount and orderTotal.

    Older fallback names remain supported
    so historical/test data still works.
  */
  const quantity =
    Math.max(
      0,
      Number(
        checkout.itemCount ??
        checkout.quantity ??
        checkout.totalItems ??
        0
      ) || 0
    );


  const value =
    Number(
      checkout.orderTotal ??
      checkout.checkoutValue ??
      checkout.value ??
      checkout.total ??
      checkout.amount ??
      0
    ) || 0;


  const items =
    getSuccessCheckoutItems(
      checkout
    );


  /*
    Recent Success intentionally shows
    no more than three products.
  */
  const previewItems =
    items.slice(
      0,
      3
    );


  const hiddenProducts =
    Math.max(
      0,
      items.length -
      previewItems.length
    );


  const productPreviewHtml =
    previewItems.length
      ? previewItems
          .map(
            (
              item,
              index
            ) =>
              renderSuccessProductPreview(
                item,
                index
              )
          )
          .join("")
      : `
          <div
            class="success-product-preview"
          >
            <div
              class="success-product-image-wrap success-product-placeholder"
            >
              <span>
                ITEM
              </span>
            </div>

            <span
              class="success-product-preview-name"
            >
              Successful Checkout
            </span>
          </div>
        `;


  container.innerHTML = `
    <div class="success-recent-shell">

      <div class="success-recent-top">

        <div>
          <span class="success-checkout-retailer">
            ${escapeHtml(retailer)}
          </span>

          <h4>
            Successful Checkout
          </h4>

          <p>
            ${escapeHtml(
              formatSuccessDate(
                date
              )
            )}
          </p>
        </div>


        <button
          type="button"
          class="success-all-orders-link"
          id="success-all-orders"
        >
          ALL ORDERS →
        </button>

      </div>


      <div class="success-product-previews">

        ${productPreviewHtml}

      </div>


      ${
        hiddenProducts > 0
          ? `
            <div
              class="success-more-products"
            >
              +${formatSuccessNumber(
                hiddenProducts
              )}
              more ${
                hiddenProducts === 1
                  ? "product"
                  : "products"
              }
            </div>
          `
          : ""
      }


      <div class="success-checkout-summary">

        <div>
          <span>
            ITEMS SECURED
          </span>

          <strong>
            ${formatSuccessNumber(
              quantity
            )}
          </strong>
        </div>


        <div>
          <span>
            CHECKOUT VALUE
          </span>

          <strong>
            ${escapeHtml(
              formatSuccessCurrency(
                value
              )
            )}
          </strong>
        </div>


        ${
          orderNumber
            ? `
              <div>
                <span>
                  ORDER
                </span>

                <strong>
                  ${escapeHtml(
                    orderNumber
                  )}
                </strong>
              </div>
            `
            : ""
        }

      </div>


      <div class="success-order-navigation">

        <button
          type="button"
          class="success-order-nav-button"
          id="success-order-previous"
          ${
            successCheckoutIndex === 0
              ? "disabled"
              : ""
          }
        >
          ← Previous Order
        </button>


        <span class="success-order-position">
          ${formatSuccessNumber(
            successCheckoutIndex + 1
          )}
          of
          ${formatSuccessNumber(
            checkouts.length
          )}
        </span>


        <button
          type="button"
          class="success-order-nav-button"
          id="success-order-next"
          ${
            successCheckoutIndex >=
            checkouts.length - 1
              ? "disabled"
              : ""
          }
        >
          Next Order →
        </button>

      </div>

    </div>
  `;


  document
    .getElementById(
      "success-order-previous"
    )
    ?.addEventListener(
      "click",
      () => {
        if (
          successCheckoutIndex <= 0
        ) {
          return;
        }

        successCheckoutIndex -= 1;

        renderSuccessCheckouts(
          checkouts
        );
      }
    );


  document
    .getElementById(
      "success-order-next"
    )
    ?.addEventListener(
      "click",
      () => {
        if (
          successCheckoutIndex >=
          checkouts.length - 1
        ) {
          return;
        }

        successCheckoutIndex += 1;

        renderSuccessCheckouts(
          checkouts
        );
      }
    );


  document
    .getElementById(
      "success-all-orders"
    )
    ?.addEventListener(
      "click",
      () => {
        renderSuccessAllOrders(
          checkouts
        );
      }
    );
}


/* =====================================================
   SUCCESS — ALL ORDERS VIEW
===================================================== */

function renderSuccessAllOrders(
  checkouts = []
) {
  const container =
    document.getElementById(
      "success-checkouts"
    );

  if (!container) {
    return;
  }


  const ordersHtml =
    checkouts
      .map(checkout => {
        const retailer =
          checkout.retailer ||
          checkout.store ||
          "Retailer";


        const orderNumber =
          checkout.orderNumber ||
          checkout.orderId ||
          checkout.id ||
          "";


        const date =
          checkout.checkoutAt ||
          checkout.date ||
          checkout.createdAt ||
          null;


        const quantity =
          Math.max(
            0,
            Number(
              checkout.itemCount ??
              checkout.quantity ??
              checkout.totalItems ??
              0
            ) || 0
          );


        const value =
          Number(
            checkout.orderTotal ??
            checkout.checkoutValue ??
            checkout.value ??
            checkout.total ??
            checkout.amount ??
            0
          ) || 0;


        const items =
          getSuccessCheckoutItems(
            checkout
          );


        const itemRows =
          items.length
            ? items
                .map(item => {
                  const name =
                    item.name ||
                    item.productName ||
                    "Item";

                  const itemQuantity =
                    Math.max(
                      1,
                      Number(
                        item.quantity ??
                        item.qty ??
                        1
                      ) || 1
                    );

                  const image =
                    getSuccessItemImage(
                      item
                    );

                  return `
                    <div
                      class="success-all-orders-item"
                    >

                      <div
                        class="success-all-orders-item-image ${
                          image
                            ? ""
                            : "success-product-placeholder"
                        }"
                      >

                        ${
                          image
                            ? `
                              <img
                                src="${escapeHtml(
                                  image
                                )}"
                                alt="${escapeHtml(
                                  name
                                )}"
                                loading="lazy"
                                referrerpolicy="no-referrer"
                              />
                            `
                            : `
                              <span>
                                ITEM
                              </span>
                            `
                        }

                      </div>


                      <div
                        class="success-all-orders-item-name"
                      >
                        ${escapeHtml(
                          name
                        )}
                      </div>


                      <strong
                        class="success-all-orders-item-quantity"
                      >
                        ×${formatSuccessNumber(
                          itemQuantity
                        )}
                      </strong>

                    </div>
                  `;
                })
                .join("")
            : `
                <div
                  class="success-all-orders-item"
                >

                  <div
                    class="success-all-orders-item-image success-product-placeholder"
                  >
                    <span>
                      ITEM
                    </span>
                  </div>

                  <div
                    class="success-all-orders-item-name"
                  >
                    Successful Checkout
                  </div>

                  <strong
                    class="success-all-orders-item-quantity"
                  >
                    ×${formatSuccessNumber(
                      Math.max(
                        1,
                        quantity
                      )
                    )}
                  </strong>

                </div>
              `;


        return `
          <article
            class="success-all-orders-card"
          >

            <div
              class="success-all-orders-head"
            >

              <div>

                <span
                  class="success-checkout-retailer"
                >
                  ${escapeHtml(
                    retailer
                  )}
                </span>

                <h4>
                  ${escapeHtml(
                    formatSuccessDate(
                      date
                    )
                  )}
                </h4>

                ${
                  orderNumber
                    ? `
                      <p>
                        Order #${escapeHtml(
                          orderNumber
                        )}
                      </p>
                    `
                    : ""
                }

              </div>


              <div
                class="success-all-orders-total"
              >
                <span>
                  ${formatSuccessNumber(
                    quantity
                  )}
                  ${
                    quantity === 1
                      ? "item"
                      : "items"
                  }
                </span>

                <strong>
                  ${escapeHtml(
                    formatSuccessCurrency(
                      value
                    )
                  )}
                </strong>
              </div>

            </div>


            <div
              class="success-all-orders-items"
            >
              ${itemRows}
            </div>

          </article>
        `;
      })
      .join("");


  container.innerHTML = `
    <div class="success-all-orders-view">

      <div class="success-all-orders-title">

        <div>
          <span class="eyebrow">
            CHECKOUT HISTORY
          </span>

          <h3>
            All Orders
          </h3>

          <p>
            Every synchronized checkout
            and the products secured in
            each order.
          </p>
        </div>


        <button
          type="button"
          class="success-order-nav-button"
          id="success-back-to-recent"
        >
          ← Back to Recent Success
        </button>

      </div>


      <div class="success-all-orders-list">
        ${ordersHtml}
      </div>

    </div>
  `;


  document
    .getElementById(
      "success-back-to-recent"
    )
    ?.addEventListener(
      "click",
      () => {
        renderSuccessCheckouts(
          checkouts
        );
      }
    );
}


function renderSuccessDashboard(
  data = {}
) {
  const summary =
    data.summary || {};

  const totalCheckouts =
    Number(
      summary.totalCheckouts ??
      data.totalCheckouts ??
      0
    ) || 0;

 const itemsSecured =
    Number(
      summary.itemsSecured ??
      summary.totalItems ??
      data.itemsSecured ??
      data.totalItems ??
      0
    ) || 0;

  const checkoutValue =
    Number(
      summary.checkoutValue ??
      summary.totalValue ??
      data.checkoutValue ??
      data.totalValue ??
      0
    ) || 0;

  const bestDay =
    summary.bestDay ??
    data.bestDay ??
    null;

  setSuccessText(
    "success-total-checkouts",
    formatSuccessNumber(
      totalCheckouts
    )
  );

  setSuccessText(
    "success-total-items",
    formatSuccessNumber(
      itemsSecured
    )
  );

  setSuccessText(
    "success-total-value",
    formatSuccessCurrency(
      checkoutValue
    )
  );

  setSuccessText(
  "success-best-day",
  Number.isFinite(
    Number(bestDay)
  )
    ? String(
        Number(bestDay)
      )
    : "—"
);

  const sync =
    data.sync || {};

  const syncStatus =
    sync.status ||
    data.syncStatus ||
    "Not connected";

  setSuccessText(
    "success-sync-status",
    syncStatus
  );

  const syncUpdated =
    document.getElementById(
      "success-sync-updated"
    );

  if (syncUpdated) {
    const lastSync =
      sync.lastSyncedAt ||
      data.lastSyncedAt ||
      null;

    syncUpdated.textContent =
      lastSync
        ? `Last synchronized ${formatSuccessDate(
            lastSync
          )}`
        : "Checkout synchronization has not run yet.";
  }

  renderSuccessChart(
    Array.isArray(data.activity)
      ? data.activity
      : []
  );

  renderSuccessCheckouts(
    Array.isArray(
      data.recentCheckouts
    )
      ? data.recentCheckouts
      : (
          Array.isArray(
            data.checkouts
          )
            ? data.checkouts
            : []
        )
  );
}


function renderSuccessLoading() {
  setSuccessText(
    "success-total-checkouts",
    "—"
  );

  setSuccessText(
    "success-total-items",
    "—"
  );

  setSuccessText(
    "success-total-value",
    "—"
  );

  setSuccessText(
    "success-best-day",
    "—"
  );

  setSuccessText(
    "success-sync-status",
    "Loading…"
  );
}


function renderSuccessError(
  message
) {
  setSuccessText(
    "success-sync-status",
    "Unavailable"
  );

  const container =
    document.getElementById(
      "success-checkouts"
    );

  if (container) {
    container.innerHTML = `
      <div class="success-empty">
        <strong>
          Success data could not be loaded.
        </strong>

        <p>
          ${escapeHtml(
            message ||
            "Please try again."
          )}
        </p>
      </div>
    `;
  }
}


async function loadSuccessDashboard(
  force = false
) {
  if (
    successState.loading
  ) {
    return;
  }

  if (
    successState.loaded &&
    !force
  ) {
    renderSuccessDashboard(
      successState.data || {}
    );

    return;
  }

  successState.loading = true;

  renderSuccessLoading();

  try {
    const successTestMode =
      new URLSearchParams(
        window.location.search
      ).get("successTest") === "1";

    const range =
      getSuccessRange();

    const query =
      new URLSearchParams({
        start:
          range.start,

        end:
          range.end
      });

    /*
      Keep the existing temporary
      admin test bridge intact.

      Production customer Success
      requests use the new date-range
      parameters.
    */
    const successEndpoint =
      successTestMode
        ? "/api/admin/test-success"
        : `/api/account/success?${query.toString()}`;

    const response =
      await fetch(
        successEndpoint,
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
      throw new Error(
        "Please sign in to view your Success dashboard."
      );
    }

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Unable to load Success data."
      );
    }

    /*
      Production returns the actual
      accepted range. Keep the browser
      synchronized with it.
    */
    if (
      !successTestMode &&
      data.range?.start &&
      data.range?.end
    ) {
      successState.rangeStart =
        data.range.start;

      successState.rangeEnd =
        data.range.end;
    }

    successState.data =
      data || {};

    successState.loaded =
      true;

    renderSuccessDashboard(
      successState.data
    );

  } catch (error) {
    successState.loaded =
      false;

    renderSuccessError(
      error.message
    );

  } finally {
    successState.loading =
      false;
  }
}


/* =====================================================
   LOAD SUCCESS WHEN SUCCESS TAB OPENS
===================================================== */

document
  .querySelectorAll(
    "[data-account-tab]"
  )
  .forEach(button => {
    button.addEventListener(
      "click",
      () => {
        if (
          button.dataset
            .accountTab ===
          "success"
        ) {
          loadSuccessDashboard();
        }
      }
    );
  });
/* =====================================================
   LOAD RETAILER PROFILES WHEN PROFILES TAB OPENS
===================================================== */

document
  .querySelectorAll(
    "[data-account-tab]"
  )
  .forEach(button => {
    button.addEventListener(
      "click",
      () => {
        /*
          Your HTML keeps the internal tab value
          "edit-profile" for compatibility, while
          the visible label is "Profiles".
        */

        if (
          button.dataset
            .accountTab ===
          "edit-profile"
        ) {
          loadRetailerProfiles();
        }
      }
    );
  });

/* =====================================================
   LOAD MY PROFILE
===================================================== */

async function loadMemberProfile(
  force = false
) {
  if (
    state.profileLoaded &&
    !force &&
    state.customer
  ) {
    showSignedIn();
    return;
  }

  try {
    const response =
      await fetch(
        "/api/my-profile",
        {
          method: "GET",

          credentials:
            "same-origin",

          cache:
            "no-store"
        }
      );

    if (
      response.status === 401
    ) {
      showSignedOut();

      if (resetToken) {
        showPasswordReset();
      }

      return;
    }

    const data =
      await readJson(
        response
      );

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Unable to load your customer profile."
      );
    }

    state.customer =
      data.account || null;

    state.orders =
      Array.isArray(
        data.orders
      )
        ? data.orders
        : [];

    state.profileLoaded = true;

    showSignedIn();

    renderAccountHeader(
      state.customer
    );

   state.membership =
  data.membership ||
  data.currentMembership ||
  null;

renderMembership(
  state.membership
);

updatePricingUpgradeButtons();

state.retailerAllowance =
  Math.max(
    0,
    Number(
      data.profileAllowance
    ) || 0
  );

state.retailerProfilesLoaded =
  false;

    renderOrders(
      state.orders
    );

    populateEditOrderSelect(
      state.orders
    );

  } catch (error) {
    state.profileLoaded =
      false;

    showAccountMessage(
      error.message,
      "error"
    );
  }
}


/* =====================================================
   SECURE LINK STARTUP
===================================================== */

async function processSecureLinks() {
  if (resetToken) {
    showPasswordReset();
    return;
  }

  if (verifyEmailToken) {
    await verifyCustomerEmail(
      verifyEmailToken
    );

    return;
  }

  if (claimToken) {
    await verifyOrderClaim(
      claimToken
    );
  }
}


/* =====================================================
   INITIALIZE
===================================================== */

renderPricing();

updateSelectedPlan();

updateCart();


const initialPage =
  location.hash.slice(1);

if (
  VALID_PAGES.includes(
    initialPage
  )
) {
  go(initialPage);
} else {
  go("home");
}


processSecureLinks();
