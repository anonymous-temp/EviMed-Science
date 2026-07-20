package com.sentum.evidencecomprehensive.pojo.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class VectorRetrievalDto {
    private String title;
    private List<String> drugSynonym;
    private List<String> diseaseSynonym;
}
