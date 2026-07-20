import { Badge } from "@/components/ui/badge";
import { useInstance } from "@/contexts/InstanceContext";

const DEFAULT_TITLE = "EviMed Science";
const DEFAULT_TAGLINE = "Memory module of the EviMed Science platform.";
const DEFAULT_LOGO = "/logo.webp";

const isCommitSha = (commit: string) => /^[0-9a-f]{7,40}$/i.test(commit);
const isSemver = (version: string) => /^\d+\.\d+\.\d+/.test(version);

const Chip = ({ children }: { children: React.ReactNode }) => {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 font-mono text-xs text-muted-foreground">{children}</span>
  );
};

const About = () => {
  const { profile, generalSetting } = useInstance();

  // Instance identity: custom branding when the admin has set it, EviMed defaults otherwise.
  const customProfile = generalSetting.customProfile;
  const instanceTitle = customProfile?.title || DEFAULT_TITLE;
  const instanceTagline = customProfile?.description || DEFAULT_TAGLINE;
  const instanceLogo = customProfile?.logoUrl || DEFAULT_LOGO;

  // Dev builds report version "dev" and commit "unknown"; show the raw version and skip the commit chip.
  const hasSemver = isSemver(profile.version);
  const versionLabel = hasSemver ? `v${profile.version}` : profile.version;
  const hasCommitSha = isCommitSha(profile.commit);
  const shortCommit = hasCommitSha ? profile.commit.slice(0, 7) : "";

  return (
    <section className="mx-auto w-full max-w-5xl min-h-full flex flex-col justify-start items-start sm:pt-3 md:pt-6 pb-8">
      <div className="w-full">
        <div className="w-full rounded-xl border border-border bg-background px-4 py-4 text-muted-foreground">
          <div className="flex min-w-0 items-center gap-4">
            <img className="size-16 shrink-0 select-none rounded-md" src={instanceLogo} alt="" draggable={false} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">{instanceTitle}</h1>
                {profile.demo && <Badge variant="warning">Demo</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{instanceTagline}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {profile.version && <Chip>{versionLabel}</Chip>}
                {shortCommit && <Chip>{shortCommit}</Chip>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default About;
