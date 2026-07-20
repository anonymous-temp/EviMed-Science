package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 用户检索条件存储的历史记录
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("evaluation_search_history")
public class SearchHistory {
    @Id
    private String id;
    /**
     * 用户检索条件
     */
    private String word;
    /**
     * 检索时间戳
     */
    private Long timeStamp;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 固定在前
     */
    private Long regularType;
}
