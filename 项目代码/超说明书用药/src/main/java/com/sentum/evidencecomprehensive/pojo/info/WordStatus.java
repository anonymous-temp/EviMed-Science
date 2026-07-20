package com.sentum.evidencecomprehensive.pojo.info;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 同义词中单词选中状态
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class WordStatus {
    /**
     * 名称
     */
    private String name;
    /**
     * 选中状态
     */
    private Boolean checked;
}
