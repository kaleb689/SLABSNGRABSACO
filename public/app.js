const PLANS = {
  1: { name: "Starter", profiles: 1, amount: 30 },
  2: { name: "Popular", profiles: 2, amount: 50 },
  3: { name: "Advanced", profiles: 3, amount: 80 },
  4: { name: "Pro", profiles: 5, amount: 130 },
  5: { name: "High Volume", profiles: 10, amount: 215 },
  6: { name: "Power User", profiles: 20, amount: 450 },
  7: { name: "Elite", profiles: 50, amount: 950 }
};

const savedTier = Number(localStorage.getItem("sng_selected_tier"));

const state = {
  tier: PLANS[savedTier] ? savedTier : null
};


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
  const target = document.getElementById(page);

  if (!target) return;

  document.querySelectorAll(".page").forEach(section => {
    section.classList.remove("active");
  });

  target.classList.add("active");

  document
    .querySelectorAll(".nav-link[data-page]")
    .forEach(link => {
      link.classList.toggle(
        "active",
        link.dataset.page === page
      );
    });

  if (location.hash !== `#${page}`) {
    history.replaceState(null, "", `#${page}`);
  }

  if (page === "my-profile") {
    loadMemberProfile();
  }

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}


document.querySelectorAll("[data-page]").forEach(element => {
  element.addEventListener("click", event => {
    event.preventDefault();

    go(element.dataset.page);
  });
});


window.addEventListener("hashchange", () => {
  const page = location.hash.slice(1);

  if (VALID_PAGES.includes(page)) {
    go(page);
  }
});


const initialPage = location.hash.slice(1);

if (VALID_PAGES.includes(initialPage)) {
  go(initialPage);
}


/* =====================================================
   PRICING CARDS
===================================================== */

function renderPricing() {
  const grid = document.getElementById("pricing-grid");

  if (!grid) return;

  grid.innerHTML = Object.entries(PLANS)
    .map(([tier, plan]) => {
      const tierNumber = Number(tier);
      const featured = tierNumber === 2;

      const profileWord =
        plan.profiles === 1 ? "Profile" : "Profiles";

      return `
        <article
          class="plan ${featured ? "featured" : ""}"
          data-tier="${tier}"
        >

          ${
            featured
              ? '<span class="popular">POPULAR</span>'
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
            ${plan.profiles} ACO ${profileWord}
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
              Target, Walmart, Sam's Club,
              Costco &amp; PKC
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

  bindTierButtons();
}


/* =====================================================
   PLAN SELECTION
===================================================== */

function bindTierButtons() {
  document
    .querySelectorAll("[data-select]")
    .forEach(button => {
      button.addEventListener("click", () => {
        selectTier(Number(button.dataset.select));
      });
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


/* =====================================================
   SELECTED PLAN
===================================================== */

function updateSelectedPlan() {
  const selected =
    document.getElementById("selected-plan");

  if (!selected) return;

  if (!state.tier || !PLANS[state.tier]) {
    selected.textContent =
      "Choose a membership first";

    return;
  }

  const plan = PLANS[state.tier];

  selected.textContent =
    `${plan.name} — $${plan.amount}/month`;
}


/* =====================================================
   CART
===================================================== */

function updateCart() {
  const count =
    document.getElementById("cart-count");

  const content =
    document.getElementById("cart-content");

  const plan =
    state.tier ? PLANS[state.tier] : null;


  if (!plan) {
    if (count) {
      count.textContent = "0";
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
        .getElementById("empty-cart-pricing")
        ?.addEventListener("click", () => {
          closeCart();
          go("pricing");
        });
    }

    return;
  }


  if (count) {
    count.textContent = "1";
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

      <button
        type="button"
        class="secondary full"
        id="cart-change"
        style="margin-top:10px"
      >
        View All Tiers
      </button>
    `;


    document
      .getElementById("cart-checkout")
      ?.addEventListener("click", () => {
        closeCart();
        go("profile");
      });


    document
      .getElementById("cart-change")
      ?.addEventListener("click", () => {
        closeCart();
        go("pricing");
      });
  }
}


function openCart() {
  const drawer =
    document.getElementById("cart-drawer");

  const backdrop =
    document.getElementById("cart-backdrop");

  if (!drawer || !backdrop) return;

  drawer.classList.add("open");
  backdrop.classList.add("open");

  drawer.setAttribute(
    "aria-hidden",
    "false"
  );
}


function closeCart() {
  const drawer =
    document.getElementById("cart-drawer");

  const backdrop =
    document.getElementById("cart-backdrop");

  if (!drawer || !backdrop) return;

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
  .getElementById("cart-backdrop")
  ?.addEventListener(
    "click",
    closeCart
  );


/* =====================================================
   GET STARTED FORM
===================================================== */

const profileForm =
  document.getElementById("profile-form");


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

    /*
      Require a membership to be selected before
      starting checkout.
    */

    if (!state.tier || !PLANS[state.tier]) {
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
      "expYear"
    ];


    const secrets =
      Object.fromEntries(
        secretKeys.map(key => [
          key,
          all[key] || ""
        ])
      );


    const cvvConfirmed =
      all.cvvConfirmed === "yes";


    const profile = {
      ...all
    };


    secretKeys.forEach(key => {
      delete profile[key];
    });


    delete profile.confirm;
    delete profile.cvvConfirmed;


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

            body: JSON.stringify({
              tier: state.tier,
              profile,
              secrets,
              cvvConfirmed
            })
          }
        );


      const data =
        await response.json();


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

const yearSelect =
  document.querySelector(
    '[name="expYear"]'
  );


if (yearSelect) {

  const currentYear =
    new Date().getFullYear();


  for (let i = 0; i < 15; i++) {

    const option =
      document.createElement(
        "option"
      );

    option.value =
      String(currentYear + i);

    option.textContent =
      String(currentYear + i);

    yearSelect.appendChild(
      option
    );
  }
}


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
        '[name="acoPassword"]'
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
   PAYMENT RETURN
===================================================== */

const params =
  new URLSearchParams(
    location.search
  );


if (
  params.get("payment") ===
  "success"
) {

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


if (
  params.get("payment") ===
  "cancelled"
) {

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
   MY PROFILE
===================================================== */

async function loadMemberProfile() {

  const card =
    document.getElementById(
      "member-card"
    );

  if (!card) return;


  card.innerHTML = `
    <div class="loading">
      Checking your membership…
    </div>
  `;


  try {

    const response =
      await fetch(
        "/api/my-profile",
        {
          credentials:
            "same-origin",

          cache:
            "no-store"
        }
      );


    if (response.status === 401) {

      card.innerHTML = `
        <div class="member-empty">

          <span class="eyebrow">
            MEMBERSHIP ACCESS
          </span>

          <h3>
            Your membership profile isn't connected yet.
          </h3>

          <p>
            Complete checkout through this site
            to connect your membership.

            If you already subscribed and need
            help accessing your profile,
            contact us through Discord.
          </p>

          <button
            type="button"
            class="primary"
            id="member-pricing"
          >
            View Memberships
          </button>

        </div>
      `;


      document
        .getElementById(
          "member-pricing"
        )
        ?.addEventListener(
          "click",
          () => {
            go("pricing");
          }
        );


      return;
    }


    const data =
      await response.json();


    if (!response.ok) {
      throw new Error(
        data.error ||
        "Unable to load membership."
      );
    }


    const daysRemaining =
      Number.isFinite(
        Number(
          data.daysRemaining
        )
      )
        ? Math.max(
            0,
            Number(
              data.daysRemaining
            )
          )
        : "—";


    card.innerHTML = `

      <div class="member-status-row">

        <div>

          <span class="eyebrow">
            MEMBERSHIP STATUS
          </span>

          <h3>
            ${escapeHtml(
              data.profileName ||
              data.username ||
              "Member"
            )}
          </h3>

        </div>

        <span
          class="
            status-pill
            ${
              data.status === "active"
                ? "active"
                : ""
            }
          "
        >
          ${escapeHtml(
            data.status ||
            "Unknown"
          )}
        </span>

      </div>


      <div class="member-grid">

        <div class="member-stat">

          <small>
            CURRENT PLAN
          </small>

          <strong>
            ${escapeHtml(
              data.planName ||
              "—"
            )}
          </strong>

        </div>


        <div class="member-stat">

          <small>
            MONTHLY PRICE
          </small>

          <strong>
            ${
              data.amount != null
                ? `$${escapeHtml(
                    data.amount
                  )}/month`
                : "—"
            }
          </strong>

        </div>


        <div class="member-stat">

          <small>
            PROFILES
          </small>

          <strong>
            ${escapeHtml(
              data.profiles ??
              "—"
            )}
          </strong>

        </div>


        <div class="member-stat">

          <small>
            DAYS REMAINING
          </small>

          <strong>
            ${escapeHtml(
              daysRemaining
            )}
          </strong>

        </div>


        <div class="member-stat wide">

          <small>
            CURRENT PERIOD ENDS
          </small>

          <strong>
            ${
              data.currentPeriodEnd
                ? escapeHtml(
                    formatDate(
                      data.currentPeriodEnd
                    )
                  )
                : "—"
            }
          </strong>

        </div>

      </div>


      <p class="member-note">
        Your membership period is based
        on your Stripe subscription
        billing period.
      </p>
    `;


  } catch (error) {

    card.innerHTML = `

      <div class="member-empty">

        <h3>
          We couldn't load your membership.
        </h3>

        <p>
          ${escapeHtml(
            error.message
          )}
        </p>

      </div>
    `;

  }
}


/* =====================================================
   HELPERS
===================================================== */

function escapeHtml(value) {

  return String(
    value ?? ""
  ).replace(
    /[&<>"']/g,
    character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[character]
  );
}


function formatDate(value) {

  const date =
    new Date(value);


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return value;
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


/* =====================================================
   INITIALIZE
===================================================== */

renderPricing();

updateSelectedPlan();

updateCart();
