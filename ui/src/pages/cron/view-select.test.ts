import { describe, expect, it } from "vitest";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { renderCronView } from "./view.test-support.ts";

describe("cron initial select values", () => {
  it("shows all configured list filters before the user changes them", () => {
    const container = renderCronView({
      jobsScheduleKindFilter: "cron",
      jobsLastStatusFilter: "error",
      jobsSortBy: "name",
      jobsSortDir: "desc",
    });
    const values = [
      ...container.querySelectorAll<HTMLSelectElement>(".cron-filter-popover select"),
    ].map((select) => select.value);

    expect(values).toEqual(["cron", "error", "name", "desc"]);
  });

  it("shows a personal task's stored internal delivery instead of announce", () => {
    const container = renderCronView({
      createOpen: true,
      personalAccess: true,
      form: { ...DEFAULT_CRON_FORM, deliveryMode: "none" },
    });
    const delivery = container.querySelector<HTMLSelectElement>("#cron-delivery-mode");

    expect(delivery?.value).toBe("none");
    expect(
      [...container.querySelectorAll<HTMLOptionElement>("#cron-delivery-mode option")].map(
        (option) => option.value,
      ),
    ).toEqual(["announce", "none"]);
  });
});
