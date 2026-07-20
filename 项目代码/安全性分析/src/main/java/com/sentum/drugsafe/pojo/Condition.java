package com.sentum.drugsafe.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.io.Serializable;

/**
 * 药物警戒检索存储实体类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("condition")
public class Condition implements Serializable {
    @Id
    private String id;
    /**
     * 1-io；2-i
     */
    private Integer type;
    /**
     * 检索干预措施 英文
     */
    private String i;
    /**
     * 检索研究对象 英文
     */
    private String o;
    /**
     * 原始干预措施存储数据 用于显示
     */
    private String originalI;
    /**
     * 原始研究对象存储数据 用于显示
     */
    private String originalO;
    /**
     * 用户实际输入的检索条件
     */
    private String condition;
    /**
     * 用户检索式
     */
    private String conditionPlus;
    /**
     * 时间戳
     */
    private Long timeStamp;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 检索类型    根据不良反应查药品表：0   药品直接query：1
     */
    private Integer route;

    private String isApp;
}
