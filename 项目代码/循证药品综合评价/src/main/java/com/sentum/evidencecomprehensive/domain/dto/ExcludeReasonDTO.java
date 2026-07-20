package com.sentum.evidencecomprehensive.domain.dto;

import cn.hutool.core.date.DateTime;
import lombok.Data;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * Description: 文献进行排除时的理由
 */
@Data
@Document("evidence_exclude_reason")
public class ExcludeReasonDTO {

    /**
     * 文献id
     */
    private String id;

    /**
     * 课题id
     */
    private String questionId;

    /**
     * 用户id
     */
    private long userId;

    /**
     * "排除类型 " +
     *             "1、研究主题（药品介绍、药物机制等主题）不相关 " +
     *             "2、文献综述/评论/新闻" +
     *             "3、数据缺失" +
     *             "4、重复文献" +
     *             "5、研究主题不相关" +
     *             "6、非经济性评价文献（非成本-效果/效益/效用，非最小成本）研究）" +
     *             "7、已纳入国外组织HTA报告的文献" +
     *             "8、其他"
     */
    private String type;

    /**
     * 排除理由
     */
    private String reason;

    /**
     * 操作时间
     */
    private DateTime updateTime;

    /**
     * 操作时间
     */
    private long updateTimeLong;
}
