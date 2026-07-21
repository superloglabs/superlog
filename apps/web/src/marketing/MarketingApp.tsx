import { Route, Routes } from "react-router-dom";
import { Blog } from "../Blog.tsx";
import { BlogPost } from "../BlogPost.tsx";
import { Changelog } from "../Changelog.tsx";
import { Landing } from "../Landing.tsx";
import { Pricing } from "../Pricing.tsx";
import { PrivacyPolicy } from "../PrivacyPolicy.tsx";
import { Roadmap } from "../Roadmap.tsx";
import { SignupSourceCapture } from "../SignupSourceCapture.tsx";
import { Team } from "../Team.tsx";
import { TermsOfService } from "../TermsOfService.tsx";

export function MarketingApp() {
  return (
    <>
      <SignupSourceCapture />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="/blog/:slug" element={<BlogPost />} />
        <Route path="/changelog" element={<Changelog />} />
        <Route path="/roadmap" element={<Roadmap />} />
        <Route path="/team" element={<Team />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/tos" element={<TermsOfService />} />
      </Routes>
    </>
  );
}
