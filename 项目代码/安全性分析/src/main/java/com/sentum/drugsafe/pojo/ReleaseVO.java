package com.sentum.drugsafe.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * 发布页相关数据
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("drug_safe_release_data")
public class ReleaseVO extends ReleaseData {
    /**
     * 收藏标志 0 未收藏 1 收藏
     */
    private int collect;
}
