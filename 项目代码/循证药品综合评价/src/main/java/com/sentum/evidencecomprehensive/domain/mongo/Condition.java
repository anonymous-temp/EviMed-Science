package com.sentum.evidencecomprehensive.domain.mongo;

import com.sentum.evidencecomprehensive.domain.dto.*;
import lombok.AllArgsConstructor;
import lombok.Data;
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
@Document("evidence_condition")
public class Condition extends BaseCondition {
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 保存检索条件的时间戳
     */
    private Long timeStamp;
    // ####################### 纳入相关 ##########################
    /**
     * 默认纳入是否已完成
     */
    private Boolean inclusionSuccess = false;
    // ####################### 信息确认页面 ##########################
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
    // ####################### 保存 condition 时 时间转换自用数据 ##########################
    private String selfLiteratureStartYear;
    private String selfLiteratureEndYear;
    private Boolean selfLiteratureYear;
    // ####################### 高级检索 ##########################
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
