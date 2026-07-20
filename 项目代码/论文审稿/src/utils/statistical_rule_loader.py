"""
Statistical Rule Set Loader - 加载统计审查规则配置
"""
import yaml
from pathlib import Path
from typing import Dict, Optional

from ..schemas.statistical_review import (
    StatisticalRuleSet,
    StudyTypeStatisticalRules,
    StatisticalCheck,
    StatisticalCheckSeverity
)


class StatisticalRuleSetLoader:
    """加载和管理统计审查规则集"""

    def __init__(self, config_path: Optional[str] = None):
        """
        初始化加载器

        Args:
            config_path: 配置文件路径，默认使用 src/config/statistical_rule_sets.yaml
        """
        if config_path is None:
            # 默认路径
            config_path = Path(__file__).parent.parent / "config" / "statistical_rule_sets.yaml"

        self.config_path = Path(config_path)
        self.rule_set: Optional[StatisticalRuleSet] = None

    def load(self) -> StatisticalRuleSet:
        """
        加载统计规则集配置

        Returns:
            StatisticalRuleSet 对象
        """
        if not self.config_path.exists():
            raise FileNotFoundError(f"Statistical rule set config not found: {self.config_path}")

        with open(self.config_path, 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f)

        # 解析检查项定义
        check_definitions = {}
        if 'statistical_checks' in config:
            for check_id, check_data in config['statistical_checks'].items():
                check_definitions[check_id] = StatisticalCheck(
                    check_id=check_id,
                    name=check_data.get('name', check_id),
                    description=check_data.get('description', ''),
                    keywords=check_data.get('keywords', []),
                    severity_if_missing=StatisticalCheckSeverity(
                        check_data.get('severity_if_missing', 'MAJOR')
                    )
                )

        # 解析研究类型规则
        study_type_rules = {}
        if 'statistical_rule_sets' in config:
            for study_type, rules_data in config['statistical_rule_sets'].items():
                study_type_rules[study_type] = StudyTypeStatisticalRules(
                    study_type=study_type,
                    description=rules_data.get('description', ''),
                    required_checks=rules_data.get('required', []),
                    recommended_checks=rules_data.get('recommended', []),
                    not_applicable_checks=rules_data.get('not_applicable', [])
                )

        self.rule_set = StatisticalRuleSet(
            study_type_rules=study_type_rules,
            check_definitions=check_definitions
        )

        return self.rule_set

    def get_applicable_checks(self, study_types: list) -> Dict[str, list]:
        """
        根据研究类型获取适用的检查项

        Args:
            study_types: 研究类型列表

        Returns:
            字典，包含 'required', 'recommended', 'not_applicable' 三个键
        """
        if self.rule_set is None:
            self.load()

        required = set()
        recommended = set()
        not_applicable = set()

        for study_type in study_types:
            rules = self.rule_set.get_rules_for_study_type(study_type)
            if rules:
                required.update(rules.required_checks)
                recommended.update(rules.recommended_checks)
                not_applicable.update(rules.not_applicable_checks)

        # 从 required 和 recommended 中移除 not_applicable 的项
        required = required - not_applicable
        recommended = recommended - not_applicable

        return {
            'required': list(required),
            'recommended': list(recommended),
            'not_applicable': list(not_applicable)
        }

    def get_check_definition(self, check_id: str) -> Optional[StatisticalCheck]:
        """获取检查项定义"""
        if self.rule_set is None:
            self.load()
        return self.rule_set.get_check_definition(check_id)

    def get_all_check_ids(self) -> list:
        """获取所有检查项ID"""
        if self.rule_set is None:
            self.load()
        return list(self.rule_set.check_definitions.keys())

    def get_supported_study_types(self) -> list:
        """获取支持的研究类型列表"""
        if self.rule_set is None:
            self.load()
        return list(self.rule_set.study_type_rules.keys())
