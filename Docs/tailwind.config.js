/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      // Opcional: podés mapear tokens a Tailwind si querés
      colors: {
        checkin: "var(--checkin)",
        contacted: "var(--contacted)",
        paid: "var(--paid)",
        partial: "var(--partial)",
        unpaid: "var(--unpaid)",
      }
    },
  },
  plugins: [],
};
