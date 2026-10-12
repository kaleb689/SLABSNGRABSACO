(() => {
  "use strict";
  const panel = document.getElementById("adminPoolBrowser");
  if (!panel) return;
  const disclosure = document.getElementById("adminPoolDisclosure");
  const browserOpen = () => !disclosure || disclosure.open;
  const queryInput = document.getElementById("adminPoolQuery");
  const retailerInput = document.getElementById("adminPoolRetailer");
  const statusInput = document.getElementById("adminPoolStatus");
  const results = document.getElementById("adminPoolResults");
  const statusLine = document.getElementById("adminPoolStatusLine");
  const prev = document.getElementById("adminPoolPrevious");
  const next = document.getElementById("adminPoolNext");
  const pageLabel = document.getElementById("adminPoolPage");
  let page = 1;
  let requestNumber = 0;
  let timer;
  let notice = "";

  const make = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = String(content);
    return node;
  };
  const addOption = (select, value, label) => select.add(new Option(label, value));
  const api = async (path, init = {}) => {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401
      ? "Admin session expired. Sign in again and search."
      : data.error || "Unable to update the profile.");
    return data;
  };
  const statusNames = {
    available: "Available",
    linked: "Linked to customer",
    held: "Restore hold",
    needs_repair: "Needs repair",
    duplicate: "Duplicate / quarantined"
  };
  const retailerNames = {
    target: "Target",
    walmart: "Walmart",
    pokemoncenter: "Pokemon Center"
  };

  async function reload() {
    // Background refreshes do not reopen the browser or fetch a hidden list.
    // Opening it always fetches fresh pool data with the current filters.
    if (!browserOpen()) return;
    const requestId = ++requestNumber;
    statusLine.textContent = "Searching account pools...";
    const params = new URLSearchParams({
      q: queryInput.value.trim(),
      retailer: retailerInput.value,
      status: statusInput.value,
      page: String(page)
    });
    try {
      const data = await api("/api/admin/managed-pool/search?" + params);
      if (requestId !== requestNumber) return;
      if (page > data.pageCount) {
        page = data.pageCount;
        return reload();
      }
      showResults(data);
      statusLine.textContent = (notice ? notice + "  ·  " : "") +
        data.total + " matching retailer profile" + (data.total === 1 ? "" : "s") +
        (data.total ? " — displaying " + ((data.page - 1) * data.pageSize + 1) +
          "–" + Math.min(data.total, data.page * data.pageSize) : "");
      notice = "";
    } catch (error) {
      if (requestId !== requestNumber) return;
      statusLine.textContent = error.message;
      results.replaceChildren();
      prev.disabled = next.disabled = true;
    }
  }

  function showResults(data) {
    results.replaceChildren();
    const customers = Array.isArray(data.customers) ? data.customers : [];
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    if (!profiles.length) results.append(make("p", "", "No profiles match these filters."));
    for (const profile of profiles) {
      const row = make("article", "pool-profile-result");
      const header = make("div", "pool-profile-title");
      const heading = make("div");
      heading.append(make("strong", "", profile.loginEmail));
      heading.append(make("div", "pool-profile-meta",
        (retailerNames[profile.retailer] || profile.retailer) +
        " · " + (profile.profileName || "Managed account")));
      const pill = make("span", "pool-profile-pill", statusNames[profile.status] || profile.status);
      pill.dataset.status = profile.status;
      header.append(heading, pill);
      row.append(header);
      row.append(make("div", "pool-profile-meta",
        "Pool record: " + profile.id));
      if (profile.assignedTo) {
        row.append(make("div", "pool-profile-meta",
          "Linked to: " + profile.assignedTo.name +
          " (" + profile.assignedTo.email + ") · " +
          (profile.assignmentType === "rented" ? "Rented" : "Gifted")));
      }

      const actions = make("div", "pool-profile-actions");
      if (profile.status === "available") {
        const edit = make("button", "pool-profile-action-edit", "Edit account");
        edit.type = "button";
        const form = make("form", "pool-profile-edit-form");
        form.hidden = true;
        const fieldGrid = make("div", "pool-edit-grid");
        function editField(label, name, value = "", type = "text") {
          const wrapper = make("label", "", label);
          const input = make("input");
          input.name = name;
          input.type = type;
          input.autocomplete = "off";
          input.value = value;
          wrapper.append(input);
          fieldGrid.append(wrapper);
          return input;
        }
        const profileName = editField("Account name", "profileName", profile.profileName || "");
        const accountEmail = editField("Account email", "accountEmail", profile.accountEmail || "");
        const notes = editField("Notes", "notes", profile.notes || "");
        const loginEmail = editField("Retailer login email", "loginEmail", profile.loginEmail || "");
        const newPassword = editField("New retailer password (optional)", "password", "", "password");
        newPassword.placeholder = "Leave blank to keep existing password";
        form.append(fieldGrid);
        const actionsRow = make("div", "pool-profile-edit-buttons");
        const save = make("button", "pool-profile-action-link", "Save changes");
        save.type = "submit";
        const cancel = make("button", "", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => { form.hidden = true; });
        actionsRow.append(save, cancel);
        form.append(actionsRow);
        const editStatus = make("p", "pool-profile-meta");
        editStatus.setAttribute("role", "status");
        form.append(editStatus);
        edit.addEventListener("click", () => { form.hidden = !form.hidden; if (!form.hidden) profileName.focus(); });
        form.addEventListener("submit", async event => {
          event.preventDefault();
          if (!window.confirm("Save changes to " + profile.loginEmail + "?")) return;
          save.disabled = true;
          editStatus.textContent = "Saving...";
          try {
            await api("/api/admin/available-memberships/" + encodeURIComponent(profile.id), {
              method: "PUT",
              headers: {"Content-Type":"application/json"},
              body: JSON.stringify({
                profileName: profileName.value,
                accountEmail: accountEmail.value,
                notes: notes.value,
                retailers: {[profile.retailer]: {username: loginEmail.value, password: newPassword.value}}
              })
            });
            notice = "Account updated.";
            await reload();
          } catch (error) {
            editStatus.textContent = error.message;
          } finally { save.disabled = false; }
        });
        row.append(form);
        const remove = make("button", "pool-profile-action-delete", "Delete account");
        remove.type = "button";
        remove.addEventListener("click", async () => {
          const account = profile.loginEmail;
          if (!window.confirm("Permanently delete the AVAILABLE managed account " + account + "? All associated retailer logins in this pool record will be deleted. This cannot be undone.")) return;
          remove.disabled = true;
          try {
            await api("/api/admin/available-memberships/" + encodeURIComponent(profile.id), {method:"DELETE"});
            notice = "Deleted available account " + account + ".";
            await reload();
          } catch (error) { statusLine.textContent = error.message; }
          finally { remove.disabled = false; }
        });
        actions.append(edit, remove);
        const assignToggle = make("button", "pool-profile-action-link pool-profile-assign-toggle", "Assign");
        assignToggle.type = "button";
        assignToggle.setAttribute("aria-expanded", "false");
        const assignmentPanel = make("div", "pool-profile-assignment-panel");
        assignmentPanel.hidden = true;
        assignToggle.addEventListener("click", () => {
          assignmentPanel.hidden = !assignmentPanel.hidden;
          assignToggle.setAttribute("aria-expanded", assignmentPanel.hidden ? "false" : "true");
          if (!assignmentPanel.hidden) customerSelect.focus();
        });
        const customerLabel = make("label", "", "Customer");
        const customerSelect = make("select");
        addOption(customerSelect, "", "Choose an active member");
        for (const customer of customers) {
          addOption(customerSelect, customer.id, customer.name + " — " + customer.email);
        }
        customerLabel.append(customerSelect);
        const typeLabel = make("label", "", "Assignment");
        const type = make("select");
        addOption(type, "free", "Gifted");
        addOption(type, "rented", "Rented");
        typeLabel.append(type);
        const durationLabel = make("label", "", "Duration");
        const duration = make("select");
        addOption(duration, "indefinite", "No expiration");
        addOption(duration, "1_drop", "1 drop");
        addOption(duration, "1_week", "1 week");
        addOption(duration, "1_month", "1 month");
        durationLabel.append(duration);
        const button = make("button", "pool-profile-action-link", "Link to customer");
        button.type = "button";
        button.disabled = customers.length === 0;
        button.addEventListener("click", async () => {
          const customer = customers.find(item => item.id === customerSelect.value);
          if (!customer) {
            statusLine.textContent = "Choose the customer to link this profile to.";
            customerSelect.focus();
            return;
          }
          if (!window.confirm("Link " + (retailerNames[profile.retailer] || profile.retailer) +
              " account " + profile.loginEmail + " to " + customer.name +
              " (" + customer.email + ") as " + type.selectedOptions[0].text + "?")) return;
          button.disabled = true;
          try {
            await api("/api/admin/available-memberships/assign", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                managedAccountId: profile.id,
                customerAccountId: customer.id,
                retailer: profile.retailer,
                assignmentType: type.value,
                durationType: duration.value,
                quantity: 1
              })
            });
            notice = "Linked " + profile.loginEmail + " to " + customer.name + ".";
            await reload();
          } catch (error) {
            statusLine.textContent = error.message;
          } finally {
            button.disabled = false;
          }
        });
        assignmentPanel.append(customerLabel, typeLabel, durationLabel, button);
        actions.append(assignToggle, assignmentPanel);
      } else if (profile.status === "linked" && profile.assignmentId &&
          ["free", "rented"].includes(profile.assignmentType)) {
        const button = make("button", "pool-profile-action-unlink", "Unlink / Return to pool");
        button.type = "button";
        button.addEventListener("click", async () => {
          const ownerName = profile.assignedTo?.name || "the current customer";
          if (!window.confirm("Unlink " + profile.loginEmail + " from " + ownerName +
              " and return it to the available pool? The managed login is kept, but customer-specific shipping and payment attachments are removed.")) return;
          button.disabled = true;
          try {
            await api("/api/admin/linked-memberships/" + encodeURIComponent(profile.assignmentType) +
              "/" + encodeURIComponent(profile.id) + "/return-to-pool", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                expectedCustomerAccountId: profile.assignedTo?.id || "",
                expectedAssignmentId: profile.assignmentId
              })
            });
            notice = "Unlinked " + profile.loginEmail + "; retailer account retained in pool.";
            await reload();
          } catch (error) {
            statusLine.textContent = error.message;
          } finally {
            button.disabled = false;
          }
        });
        actions.append(button);
      } else if (profile.status === "held") {
        const button = make("button", "pool-profile-action-link", "Override Restore Hold");
        button.type = "button";
        button.addEventListener("click", async () => {
          if (!window.confirm("Override the Restore Hold on " + profile.loginEmail +
              "? This releases only this account to available inventory. Existing customer assignments are not changed.")) return;
          button.disabled = true;
          try {
            await api("/api/admin/managed-pool/" + encodeURIComponent(profile.id) + "/override-hold", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({confirmed:true})
            });
            notice = "Restore Hold released for " + profile.loginEmail + ".";
            await reload();
          } catch (error) {
            statusLine.textContent = error.message;
          } finally {
            button.disabled = false;
          }
        });
        actions.append(button);
      } else if (profile.status === "needs_repair") {
        const button = make("button", "pool-profile-action-link", "Mark Repaired");
        button.type = "button";
        button.addEventListener("click", async () => {
          if (!window.confirm("Confirm that " + profile.loginEmail +
              " has been repaired and tested? This clears Needs Repair and returns its managed account to the available pool.")) return;
          button.disabled = true;
          try {
            await api("/api/admin/managed-pool/" + encodeURIComponent(profile.id) + "/mark-repaired", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({retailer: profile.retailer, confirmed: true})
            });
            notice = "Marked " + profile.loginEmail + " repaired.";
            await reload();
          } catch (error) {
            statusLine.textContent = error.message;
          } finally {
            button.disabled = false;
          }
        });
        actions.append(button);
      } else {
        actions.append(make("span", "pool-profile-meta",
          profile.status === "held"
            ? "Release this account's restore hold before assigning it."
            : profile.status === "needs_repair"
              ? "Repair this account before linking it."
              : profile.status === "duplicate"
                ? "Resolve the duplicate before linking it."
                : "This account cannot be linked until its status is resolved."));
      }
      row.append(actions);
      results.append(row);
    }
    const pageCount = Number(data.pageCount || 1);
    pageLabel.textContent = "Page " + page + " of " + pageCount;
    prev.disabled = page <= 1;
    next.disabled = page >= pageCount;
  }

  function scheduleReload() {
    page = 1;
    clearTimeout(timer);
    timer = setTimeout(reload, 250);
  }
  queryInput.addEventListener("input", scheduleReload);
  retailerInput.addEventListener("change", scheduleReload);
  statusInput.addEventListener("change", scheduleReload);
  document.getElementById("adminPoolSearchButton").addEventListener("click", () => {
    clearTimeout(timer);
    page = 1;
    reload();
  });
  prev.addEventListener("click", () => {
    if (page > 1) { page--; reload(); }
  });
  next.addEventListener("click", () => { page++; reload(); });
  window.refreshAdminPoolSearch = reload;
  if (disclosure) {
    disclosure.addEventListener("toggle", () => {
      if (disclosure.open) {
        void reload();
      } else {
        // Invalidate requests started before collapse so stale results never appear.
        ++requestNumber;
        clearTimeout(timer);
      }
    });
  }
  // A visitor may sign into Admin after the initial search returned 401.
  // Re-query once when the existing Admin dashboard becomes visible.
  const dashboard = document.getElementById("dashboard");
  if (dashboard) {
    let wasHidden = dashboard.hidden;
    new MutationObserver(() => {
      const isHidden = dashboard.hidden;
      if (wasHidden && !isHidden && browserOpen()) void reload();
      wasHidden = isHidden;
    }).observe(dashboard, { attributes: true, attributeFilter: ["hidden"] });
  }
  if (browserOpen()) void reload();
})();
