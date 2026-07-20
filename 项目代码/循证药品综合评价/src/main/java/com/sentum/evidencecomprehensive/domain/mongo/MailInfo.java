package com.sentum.evidencecomprehensive.domain.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 站内信相关数据
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evidence_mail_info")
public class MailInfo {
    /**
     * id
     */
    private String id;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 站内信实际内容
     */
    private String info;
    /**
     * 站内信创建时间
     */
    private Long createTime;
    /**
     * 站内信状态；0-未读；1-已读
     */
    private Integer status;
    /**
     * 站内信读取时间
     */
    private Long readTime;
}
