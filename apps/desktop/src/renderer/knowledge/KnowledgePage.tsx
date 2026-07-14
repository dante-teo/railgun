import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import type { SkillDetail, SkillSummary } from "../../shared/types";
import { Button } from "../components/ui/button";
import { MarkdownMessage } from "../chat/MarkdownMessage";
import { errorMessage } from "../lib/utils";

interface KnowledgePageProps { readonly onBack: () => void }

export const KnowledgePage = ({ onBack }: KnowledgePageProps): React.JSX.Element => {
  const [skills, setSkills] = useState<readonly SkillSummary[]>();
  const [selectedName, setSelectedName] = useState<string>();
  const [detail, setDetail] = useState<SkillDetail>();
  const [query, setQuery] = useState("");
  const [listError, setListError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [detailRetry, setDetailRetry] = useState(0);

  const loadSkills = async (): Promise<void> => {
    setListError(undefined);
    try {
      const next = await window.railgunDesktop.listSkills();
      setSkills(next);
      setSelectedName(current => current !== undefined && next.some(skill => skill.name === current) ? current : next[0]?.name);
    } catch (error) { setListError(errorMessage(error, "Unable to load skills")); }
  };
  useEffect(() => { void loadSkills(); }, []);
  useEffect(() => {
    if (selectedName === undefined) { setDetail(undefined); return; }
    let active = true;
    setDetail(undefined); setDetailError(undefined);
    void window.railgunDesktop.getSkill(selectedName).then(
      value => { if (active) setDetail(value); },
      error => { if (active) setDetailError(errorMessage(error, "Unable to load the skill")); },
    );
    return () => { active = false; };
  }, [selectedName, detailRetry]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return skills?.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle)) ?? [];
  }, [query, skills]);

  return <main className="knowledge-shell">
    <aside className="knowledge-master">
      <div className="settings-traffic-clearance" aria-hidden="true" />
      <button type="button" className="settings-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to Railgun</button>
      <header><h1>Knowledge</h1><p>Skills available to Railgun.</p></header>
      <label className="settings-search-wrap"><Search aria-hidden="true" /><input type="search" aria-label="Search skills" placeholder="Search skills" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <nav aria-label="Skills">
        {skills === undefined && listError === undefined ? <p role="status">Loading skills…</p> : null}
        {listError === undefined ? null : <div role="alert"><p>{listError}</p><Button size="sm" onClick={() => void loadSkills()}>Retry</Button></div>}
        {skills !== undefined && skills.length === 0 ? <p>No skills installed</p> : null}
        {skills !== undefined && skills.length > 0 && filtered.length === 0 ? <p>No matching skills</p> : null}
        {filtered.map(skill => <button type="button" key={skill.name} aria-current={selectedName === skill.name ? "page" : undefined} className={selectedName === skill.name ? "selected" : ""} onClick={() => setSelectedName(skill.name)}><strong>{skill.name}</strong><span>{skill.description}</span></button>)}
      </nav>
    </aside>
    <section className="knowledge-detail" aria-label="Skill detail">
      {selectedName === undefined ? <div className="knowledge-state"><h2>Skills</h2><p>Select a skill to read its instructions.</p></div>
        : detailError !== undefined ? <div className="knowledge-state" role="alert"><p>{detailError}</p><Button size="sm" onClick={() => setDetailRetry(value => value + 1)}>Retry</Button></div>
          : detail === undefined ? <div className="knowledge-state" role="status">Loading skill…</div>
            : <article><header><h1>{detail.name}</h1><p>{detail.description}</p><span className={`skill-status ${detail.disableModelInvocation ? "disabled" : "enabled"}`}>{detail.disableModelInvocation ? "Model invocation disabled" : "Available to model"}</span></header><MarkdownMessage>{detail.body}</MarkdownMessage></article>}
    </section>
  </main>;
};
