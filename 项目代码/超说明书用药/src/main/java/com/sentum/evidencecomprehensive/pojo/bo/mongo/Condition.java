package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.InterventionAndOutcome;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * 用户检索条件存储类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@EqualsAndHashCode(callSuper = false, exclude = {"id", "timeStamp", "userId"})
@Document("evidence_condition")
public class Condition {
    @Override
    public String toString() {
        return "Condition{" +
                "id='" + id + '\'' +
                ", isTranslate=" + isTranslate +
                ", drugs=" + drugs +
                ", diseases=" + diseases +
                ", interventions=" + interventions +
                ", outcomes=" + outcomes +
                ", studyType=" + studyType +
                ", userId=" + userId +
                ", timeStamp=" + timeStamp +
                ", inclusionSuccess=" + inclusionSuccess +
                '}';
    }

    /**
     * 检索的唯一id
     */
    private String id;
    /**
     * 是否需要翻译 1翻译 2不翻译，默认1翻译
     */
    private Integer isTranslate = 1;
    /**
     * 药品信息
     */
    private List<Drug> drugs;
    /**
     * 疾病信息
     */
    private List<Disease> diseases;
    /**
     * 对比药物
     */
    private List<InterventionAndOutcome> interventions;
    /**
     * 结局指标
     */
    private List<InterventionAndOutcome> outcomes;
    /**
     * 用户勾选的研究类型
     */
    private List<Integer> studyType;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 保存检索条件的时间戳
     */
    private Long timeStamp;

    /**
     * 默认纳入是否已完成
     */
    private Boolean inclusionSuccess = false;

    /**
     * 弹框指南检索起始年份
     */
    private String guideStartYear;
    /**
     * 弹框指南检索结束年份
     */
    private String guideEndYear;
    /**
     * 弹框文献检索起始年份
     */
    private String literatureStartYear;
    /**
     * 弹框文献检索结束年份
     */
    private String literatureEndYear;
    /**
     * 弹框中文期刊来源
     */
    private List<String> zhJournal;
    /**
     * 弹框英文期刊来源
     */
    private List<String> enJournal;

    /**
     * 去修饰之后的疾病信息--指南
     */
    private List<Disease> guideWipeDiseases;
    /**
     * 去修饰之后的疾病信息--文献
     */
    private List<Disease> literatureWipeDiseases;

    /**
     * 检索式
     */
    private String mode;
    /**
     * 中英文扩展 1选中 0未选中
     */
    private String zhEnExtension;
    /**
     * 同义词扩展  1选中 0未选中
     */
    private String synonymExtension;
}
