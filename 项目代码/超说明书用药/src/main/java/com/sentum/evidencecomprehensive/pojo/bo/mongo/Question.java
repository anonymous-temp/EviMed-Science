package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 课题
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_question")
public class Question {
    /**
     * 检索id
     */
    @Id
    private String id;
    /**
     * 来源id
     */
    private String tarId;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 创建当前课题的用户id
     */
    private Long createUserId;
    /**
     * 课题名称
     */
    private String name;
    /**
     * 创建时间
     */
    private Long createTime;
    /**
     * 最后修改时间
     */
    private Long updateTime;
    /**
     * 收藏状态：1-收藏；0-未收藏
     */
    private Integer collectStatus = 0;
    /**
     * 父类id
     */
    private String pId;
    /**
     * 历史记录的编号
     */
    private Integer historyNum;
    /**
     * 1-超说明书；2-循证综合评价；3-中兴
     */
    private Integer type;
}
