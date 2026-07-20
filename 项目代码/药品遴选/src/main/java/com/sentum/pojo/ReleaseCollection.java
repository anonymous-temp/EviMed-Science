package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 发布页面用户收藏
 * @author zgm
 */
@NoArgsConstructor
@AllArgsConstructor
@Data
@Document("evaluation_release_collection")
public class ReleaseCollection {
    @Id
    private String id;
    /**
     * 用户id
     */
    private Long userId;
    /**
     * 发布id
     */
    private String releaseId;
    /**
     * 收藏时间
     */
    private Long timeStamp;
}
