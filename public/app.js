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
  tier: PLANS[savedTier] ? savedTier : null,
  customer: null,
  orders: [],
  profileLoaded: false,

  retailerProfiles: [],
  retailerAllowance: 0,
  retailerProfilesLoaded: false
};


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

function bindTierButtons() {
  document
    .querySelectorAll(
      "[data-select]"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        () => {
          selectTier(
            Number(
              button.dataset.select
            )
          );
        }
      );
    });
}


function selectTier(tier) {
  if (!PLANS[tier]) return;

  state.tier = tier;

  localStorage.setItem(
    "sng_selected_tier",
    String(tier)
  );

  updateSelectedPlan();
  updateCart();
  openCart();
}


function clearSelectedTier() {
  state.tier = null;

  localStorage.removeItem(
    "sng_selected_tier"
  );

  updateSelectedPlan();
  updateCart();
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
  state.orders = [];
  state.profileLoaded = true;

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

  setText(
    "membership-status",
    status
  );

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

/*
  Membership upgrades must be handled by Stripe
  on the server so an existing subscription is
  changed safely rather than accidentally creating
  a second subscription.

  Until the dedicated server-side upgrade route is
  added, this button takes the customer to the tier
  list without creating another subscription.
*/

document
  .getElementById(
    "upgrade-membership"
  )
  ?.addEventListener(
    "click",
    () => {
      showAccountMessage(
        "Choose the membership you are interested in. Existing membership upgrades will be processed through the secure Stripe upgrade flow.",
        "info"
      );

      go("pricing");
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

    container.innerHTML = `
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
    `;


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


  container.innerHTML =
    cards.join("");


  bindRetailerPasswordToggles();

  bindRetailerProfileForms();


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

/* =====================================================
   SUCCESS DASHBOARD
===================================================== */

const successState = {
  loaded: false,
  loading: false,
  data: null
};


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

  if (
    !Array.isArray(activity) ||
    activity.length === 0
  ) {
    chart.innerHTML = `
      <div class="success-chart-empty">
        Checkout activity will appear
        here after successful checkouts
        are synchronized.
      </div>
    `;

    return;
  }

  const maximum =
    Math.max(
      1,
      ...activity.map(item =>
        Math.max(
          0,
          Number(
            item.count ??
            item.checkouts ??
            0
          ) || 0
        )
      )
    );

  chart.innerHTML =
    activity
      .map(item => {
        const count =
          Math.max(
            0,
            Number(
              item.count ??
              item.checkouts ??
              0
            ) || 0
          );

        const height =
          count > 0
            ? Math.max(
                8,
                Math.round(
                  (
                    count /
                    maximum
                  ) * 100
                )
              )
            : 0;

        const label =
          item.label ||
          item.date ||
          "";

        return `
          <div
            class="success-chart-column"
            title="${escapeHtml(
              `${label}: ${count} checkout${
                count === 1
                  ? ""
                  : "s"
              }`
            )}"
          >
            <div
              class="success-chart-bar-wrap"
            >
              <div
                class="success-chart-bar"
                style="height: ${height}%"
              ></div>
            </div>

            <span>
              ${escapeHtml(label)}
            </span>
          </div>
        `;
      })
      .join("");
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

  container.innerHTML =
    checkouts
      .map(checkout => {
        const retailer =
          checkout.retailer ||
          checkout.store ||
          "Retailer";

        const product =
          checkout.product ||
          checkout.productName ||
          checkout.item ||
          "Successful Checkout";

        const quantity =
          Math.max(
            1,
            Number(
              checkout.quantity ??
              checkout.items ??
              1
            ) || 1
          );

        const value =
          Number(
            checkout.value ??
            checkout.total ??
            checkout.amount ??
            0
          ) || 0;

        const date =
          checkout.checkoutAt ||
          checkout.date ||
          checkout.createdAt ||
          null;

        return `
          <article
            class="success-checkout-card"
          >
            <div
              class="success-checkout-main"
            >
              <span
                class="success-checkout-retailer"
              >
                ${escapeHtml(retailer)}
              </span>

              <h4>
                ${escapeHtml(product)}
              </h4>

              <p>
                ${escapeHtml(
                  formatSuccessDate(date)
                )}
              </p>
            </div>

            <div
              class="success-checkout-meta"
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
          </article>
        `;
      })
      .join("");
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
      data.itemsSecured ??
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
    "success-items-secured",
    formatSuccessNumber(
      itemsSecured
    )
  );

  setSuccessText(
    "success-checkout-value",
    formatSuccessCurrency(
      checkoutValue
    )
  );

  setSuccessText(
    "success-best-day",
    bestDay
      ? (
          typeof bestDay ===
          "object"
            ? (
                bestDay.label ||
                formatSuccessDate(
                  bestDay.date
                )
              )
            : formatSuccessDate(
                bestDay
              )
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
    Array.isArray(data.checkouts)
      ? data.checkouts
      : []
  );
}


function renderSuccessLoading() {
  setSuccessText(
    "success-total-checkouts",
    "—"
  );

  setSuccessText(
    "success-items-secured",
    "—"
  );

  setSuccessText(
    "success-checkout-value",
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
    const response =
      await fetch(
        "/api/account/success",
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

   renderMembership(
  data.membership ||
  data.currentMembership ||
  null
);

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
