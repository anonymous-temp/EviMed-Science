package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.util.List;

/**
 * @Description:
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class EvidenceMesh {
    
    // 原词
    private String title;
    
    // 原词中文
    private String nameZh;
    
    // 原词英文
    private String nameEn;
    
    // 原词同义词
    private List<String> entryTerms;
}
