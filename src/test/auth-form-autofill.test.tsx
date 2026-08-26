// What the sign-in form tells a password manager about itself.
//
// Chrome logged this on every load of /auth, measured over CDP against a real
// headless Chrome:
//
//   [DOM] Input elements should have autocomplete attributes
//         (suggested: "current-password")  https://goo.gl/9p2vKq
//
// which is the browser saying it cannot tell what these fields are. Neither input
// had a `name` or an `autoComplete`, and a manager that guesses wrong either fails
// to fill the account or saves the wrong entry against this origin.
//
// The part worth a test rather than a one-line fix is that /auth is one component
// in two modes. `isLogin` toggles the same two inputs between signing in and
// creating an account, and the correct attribute differs: `current-password` asks
// the manager to fill the saved credential, `new-password` tells it not to and to
// offer a generated one instead. A hardcoded `current-password` would ask the
// browser to autofill an existing password into a field for an account that does
// not exist yet — which is why the assertion here follows the toggle rather than
// checking the attribute is merely present.
//
// The last test is a source scan rather than a render, deliberately. The same class
// of defect lives on the API-key dialog in ChatSidebar, where `type="password"` is
// masking rather than a credential and the right answer is `autoComplete="off"` —
// and it will live on the next password-shaped input someone adds. Rendering that
// dialog needs the whole sidebar and its Firestore mocks; reading the source costs
// nothing and covers inputs that do not exist yet.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync, readdirSync } from "fs";
import { join, resolve, relative } from "path";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(async () => undefined),
  signUp: vi.fn(async () => undefined),
  signInWithGoogle: vi.fn(async () => undefined),
  continueAsGuest: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: null,
    signIn: mocks.signIn,
    signUp: mocks.signUp,
    signInWithGoogle: mocks.signInWithGoogle,
    continueAsGuest: mocks.continueAsGuest,
  }),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => mocks.navigate,
}));

import Auth from "@/pages/Auth";

const ROOT = process.cwd();

function renderAuth() {
  return render(
    <MemoryRouter>
      <Auth />
    </MemoryRouter>,
  );
}

/** The password field, found the way a manager finds it: by type, not by test id. */
function passwordInput(): HTMLInputElement {
  const el = document.querySelector('input[type="password"]');
  expect(el, "no password input rendered").not.toBeNull();
  return el as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the sign-in form describes itself to a password manager", () => {
  it("names the email field and asks for the account", () => {
    renderAuth();
    const email = document.querySelector('input[type="email"]') as HTMLInputElement;
    expect(email, "no email input rendered").not.toBeNull();
    expect(email.getAttribute("name")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("email");
  });

  it("asks for the saved password when signing in", () => {
    renderAuth();
    // Control: this is the login mode, so the assertion below is about the mode
    // and not about whatever the component happens to render first.
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    const password = passwordInput();
    expect(password.getAttribute("name")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
  });

  it("stops asking for it once the form becomes a sign-up", () => {
    renderAuth();
    expect(passwordInput().getAttribute("autocomplete")).toBe("current-password");

    fireEvent.click(screen.getByRole("button", { name: /don't have an account\?/i }));

    // The mode really did change — without this the test below could pass on a
    // form that never toggled.
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
    expect(passwordInput().getAttribute("autocomplete")).toBe("new-password");
  });

  it("goes back to the saved password when the form toggles back", () => {
    renderAuth();
    fireEvent.click(screen.getByRole("button", { name: /don't have an account\?/i }));
    fireEvent.click(screen.getByRole("button", { name: /already have an account\?/i }));
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(passwordInput().getAttribute("autocomplete")).toBe("current-password");
  });

  it("leaves no password-shaped input in the app without an explicit autoComplete", () => {
    // A masked field with no autoComplete is the browser's cue to treat the form
    // as a login: it will offer to fill this origin's saved password into an API
    // key box, and offer to save an API key as a password. Every such input has to
    // say which it is — a credential (`current-password`/`new-password`) or not
    // (`off`).
    const offenders: string[] = [];
    let inputsFound = 0;

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "test") walk(full);
        } else if (/\.tsx$/.test(entry.name)) {
          const src = readFileSync(full, "utf8");
          // Each JSX element that carries type="password", from the tag name to
          // the closing bracket of the opening tag.
          for (const m of src.matchAll(/<[A-Za-z][^<>]*?type="password"[^<>]*?>/gs)) {
            inputsFound++;
            if (!/autoComplete=/.test(m[0])) {
              offenders.push(`${relative(ROOT, full)}: ${m[0].replace(/\s+/g, " ").slice(0, 90)}`);
            }
          }
        }
      }
    };
    walk(resolve(ROOT, "src"));

    // Control: a walk or a regex that finds nothing would report a clean codebase.
    // Three known fields at the time of writing — the sign-in password and the two
    // provider keys — so anything below that means the scan stopped seeing them.
    expect(inputsFound, "the password-input scan found nothing").toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});
