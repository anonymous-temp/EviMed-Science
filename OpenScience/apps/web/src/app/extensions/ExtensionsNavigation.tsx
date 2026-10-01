import { useNavigate } from "react-router";
import { Tabs } from "@/components/ui/Tabs";

export function ExtensionsNavigation({ value }: { value: "plugins" | "skills" }) {
  const navigate = useNavigate();
  return <Tabs label="扩展中心" value={value} items={[{ value: "plugins", label: "插件" }, { value: "skills", label: "技能" }]}
    onChange={next => navigate(`/app/extensions/${next}`)} />;
}
